import { App, Notice, TFile, moment, normalizePath, parseYaml } from 'obsidian';
import { AudioLinkStatus } from './reader-types';
import { cleanVaultFolderPath } from './vault-path';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from '../settings/settings';
import { ResolvedNarrator, VoiceConfig } from '../settings/profiles';
import { concatArrayBuffers, sanitizeFilenameComponent } from './audio-utils';
import { getProviderApiKey, resolveVoiceLabel } from '../tts/registry';
import { extractFrontmatterYaml, hashText, stripFrontmatter } from '../text/text-utils';

/**
 * A note's saved audio: writing the `.mp3` next to it, linking it in the note's frontmatter, deciding whether
 * it is up to date or outdated (by hashing the note), and clearing it. Everything here goes through the vault
 * and the note's frontmatter; playback and generation live in {@link Reader}.
 */
/**
 * Marks staleness hashes computed by {@link SavedAudio.stalenessHash} (1.1+). Hashes stored by 1.0.0 have no
 * prefix and are checked with the 1.0.0 algorithm instead, so existing saved audio stays up to date.
 */
const HASH_VERSION_PREFIX = 'v2:';

export class SavedAudio {
	constructor(
		private app: App,
		private settings: NoteNarratorSettings,
		/** Called after a note's audio properties are written or removed, so open views can refresh. */
		private onAudioStatusChange: (file: TFile) => void,
	) {}

	/**
	 * `contentHash` is the note's staleness hash (see {@link stalenessHash}) for the text the audio was
	 * generated from, captured when generation started. Required on purpose: hashing the note as it is when
	 * saving finishes instead would mark the audio up to date even if the note was edited while it generated.
	 */
	async saveAudioFile(
		chunks: ArrayBuffer[],
		sourceFile: TFile | null,
		chunkDurations: number[],
		narrator: ResolvedNarrator,
		contentHash: string,
	): Promise<void> {
		try {
			const apiKey = getProviderApiKey(this.app, narrator.provider);
			const voiceName = apiKey ? await resolveVoiceLabel(narrator.provider, narrator.voice, apiKey) : this.voiceFallbackLabel(narrator.voice);
			const data = concatArrayBuffers(chunks);

			const existingAudioFile =
				this.settings.saveVersioning === 'replace' && this.settings.linkAudioInNote && sourceFile
					? this.findExistingAudioFile(sourceFile)
					: null;

			let audioFile: TFile;
			if (existingAudioFile) {
				await this.app.vault.modifyBinary(existingAudioFile, data);
				audioFile = existingAudioFile;
				new Notice(`Updated audio at ${audioFile.path}`);
			} else {
				const folderPath = this.resolveSaveFolder(sourceFile);
				await this.ensureFolder(folderPath);
				const noteName = sourceFile?.basename ?? `Reading ${moment().format('YYYY-MM-DD HHmmss')}`;
				const baseName = sanitizeFilenameComponent(`${noteName} (${voiceName})`);
				const path = await this.uniquePath(folderPath, baseName, 'mp3');
				audioFile = await this.app.vault.createBinary(path, data);
				new Notice(`Saved audio to ${path}`);
			}

			if (this.settings.linkAudioInNote && sourceFile) {
				const chunkMeta = chunkDurations.map((duration, i) => ({ duration, byteLength: chunks[i]?.byteLength ?? 0 }));
				await this.linkAudioInNote(audioFile, sourceFile, chunkMeta, narrator, contentHash);
			}
		} catch (error) {
			console.error('Note Narrator: failed to save audio file', error);
			new Notice(`Failed to save audio file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Label for a saved filename when the voice's real name can't be looked up (no API key). */
	private voiceFallbackLabel(voice: VoiceConfig): string {
		return voice.voiceId;
	}

	private findExistingAudioFile(sourceFile: TFile): TFile | null {
		const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
		const storedPath: unknown = frontmatter?.[this.settings.audioPathProperty];
		// The property is user-editable, so clean it up (stray slashes, non-breaking spaces, non-NFC Unicode) before the lookup.
		if (typeof storedPath !== 'string' || !storedPath) return null;
		const file = this.app.vault.getAbstractFileByPath(normalizePath(storedPath));
		return file instanceof TFile ? file : null;
	}

	/**
	 * Staleness hash for a note, excluding Note Narrator's own bookkeeping properties from the frontmatter
	 * before hashing. Hashing raw file content directly would be self-referential: linkAudioInNote() writes
	 * these properties (including this very hash) into the file's frontmatter right after computing it, so
	 * every later read of "current content" would include them while the stored hash never could —
	 * guaranteeing a permanent mismatch. Excluding them keeps the hash stable across saves.
	 *
	 * `rawContent` is the note's full text, frontmatter included. Both halves of the hash come from it, so an
	 * editor's unsaved text hashes the same as that text once it's on disk: the frontmatter is parsed from
	 * `rawContent` rather than read from the metadata cache (which lags unsaved edits), and line endings are
	 * normalized (the editor works in LF while a file on disk may still use CRLF).
	 */
	stalenessHash(rawContent: string, file: TFile): string {
		const content = rawContent.replace(/\r\n/g, '\n');
		return `${HASH_VERSION_PREFIX}${this.hashNote(this.parseFrontmatter(content, file), stripFrontmatter(content))}`;
	}

	/**
	 * The hash before 1.1: frontmatter from the metadata cache, no line-ending normalization, no version
	 * prefix. Only used to check hashes stored by 1.0.0 (unprefixed), never stored, so audio saved by an
	 * older version doesn't all turn "outdated" on update just because the hash is now computed differently.
	 */
	private legacyStalenessHash(rawContent: string, file: TFile): string {
		return this.hashNote(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}, stripFrontmatter(rawContent));
	}

	/** Falls back to the metadata cache's copy if the YAML doesn't parse (Obsidian's own view of it is the best we have then). */
	private parseFrontmatter(content: string, file: TFile): Record<string, unknown> {
		const yaml = extractFrontmatterYaml(content);
		if (yaml === null) return {};
		try {
			const parsed: unknown = parseYaml(yaml);
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
		} catch {
			return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		}
	}

	private hashNote(sourceFrontmatter: Record<string, unknown>, body: string): string {
		const frontmatter: Record<string, unknown> = { ...sourceFrontmatter };
		delete frontmatter.position;
		delete frontmatter[this.settings.audioLinkProperty];
		delete frontmatter[this.settings.audioHashProperty];
		delete frontmatter[this.settings.audioPathProperty];
		delete frontmatter[this.settings.audioTimestampProperty];
		delete frontmatter[this.settings.audioVoiceProperty];
		delete frontmatter[this.settings.audioChunkDurationsProperty];
		for (const key of this.settings.extraStaleHashExcludedProperties.split('\n')) {
			const trimmed = key.trim();
			if (trimmed) delete frontmatter[trimmed];
		}
		return hashText(`${JSON.stringify(frontmatter)}\n${body}`);
	}

	/**
	 * `processFrontMatter()`'s returned promise can resolve before `metadataCache.getFileCache()` actually
	 * reflects the write — the cache recomputes on its own pipeline after the underlying `vault.modify`,
	 * not synchronously as part of the write call. Callers that immediately re-read frontmatter via the
	 * cache (like the panel's Play saved/status checks, triggered off `audio-status-change`) would see the
	 * stale pre-write cache otherwise. Waits for the cache's own 'changed' event for this file, with a
	 * timeout as a safety net in case that event is ever missed.
	 */
	private waitForMetadataCacheUpdate(file: TFile): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				this.app.metadataCache.offref(ref);
				window.clearTimeout(timeoutId);
				resolve();
			};
			const ref = this.app.metadataCache.on('changed', (changedFile: TFile) => {
				if (changedFile.path === file.path) finish();
			});
			const timeoutId = window.setTimeout(finish, 2000);
		});
	}

	private async linkAudioInNote(
		audioFile: TFile,
		sourceFile: TFile,
		chunkMeta: { duration: number; byteLength: number }[],
		narrator: ResolvedNarrator,
		contentHash: string,
	): Promise<void> {
		const link = this.app.fileManager.generateMarkdownLink(audioFile, sourceFile.path);

		const cacheUpdated = this.waitForMetadataCacheUpdate(sourceFile);
		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			frontmatter[this.settings.audioLinkProperty] = link;
			frontmatter[this.settings.audioHashProperty] = contentHash;
			frontmatter[this.settings.audioPathProperty] = audioFile.path;
			frontmatter[this.settings.audioTimestampProperty] = moment().toISOString(true);
			// A fingerprint of the narrator's voice settings, not its name or provider account, so renaming a profile doesn't look like a new narrator.
			frontmatter[this.settings.audioVoiceProperty] = narrator.fingerprint;
			// [duration, byteLength] pairs -- one property instead of two. Byte lengths let a saved file be
			// sliced back into its per-chunk buffers for reliable Previous/Next part; see SavedPlaybackTimeline.
			frontmatter[this.settings.audioChunkDurationsProperty] = chunkMeta.map((m) => [Math.round(m.duration * 100) / 100, m.byteLength]);
		});
		await cacheUpdated;

		this.onAudioStatusChange(sourceFile);
	}

	/** Removes just the reader-audio frontmatter properties (not the audio file itself), used by both the user-facing clear action and silent missing-file cleanup. */
	private async removeReaderProperties(sourceFile: TFile): Promise<void> {
		const cacheUpdated = this.waitForMetadataCacheUpdate(sourceFile);
		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			delete frontmatter[this.settings.audioLinkProperty];
			delete frontmatter[this.settings.audioHashProperty];
			delete frontmatter[this.settings.audioPathProperty];
			delete frontmatter[this.settings.audioTimestampProperty];
			delete frontmatter[this.settings.audioVoiceProperty];
			delete frontmatter[this.settings.audioChunkDurationsProperty];
		});
		await cacheUpdated;

		this.onAudioStatusChange(sourceFile);
	}

	/** Deletes a note's linked audio file (if any) and removes the Note Narrator audio properties from its frontmatter. */
	async clearReaderFiles(sourceFile: TFile): Promise<void> {
		const audioFile = this.findExistingAudioFile(sourceFile);
		if (audioFile) {
			await this.app.fileManager.trashFile(audioFile);
		}

		await this.removeReaderProperties(sourceFile);

		new Notice(audioFile ? 'Cleared Note Narrator audio file and properties.' : 'Cleared Note Narrator properties (no audio file was linked).');
	}

	/** Compares the note's current content against the hash stored when its linked audio was last generated. */
	async getAudioStatus(file: TFile): Promise<AudioLinkStatus> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const link = frontmatter?.[this.settings.audioLinkProperty] as string | undefined;
		// User-editable, so not necessarily text (e.g. edited into a number): anything else is just "outdated".
		const storedHash: unknown = frontmatter?.[this.settings.audioHashProperty];
		if (!link || !storedHash) return 'none';

		// The note still links to audio that's since been moved/deleted outside Note Narrator — there's
		// nothing to be "outdated" relative to, so clean up the stale properties instead of showing a
		// misleading status. Self-stabilizing: once cleaned, `link`/`storedHash` above are gone and this
		// short-circuits to 'none' on the next call without re-checking the vault.
		if (!this.findExistingAudioFile(file)) {
			if (this.settings.autoCleanupMissingAudioProperties) {
				await this.removeReaderProperties(file);
				new Notice('Cleaned up stale Note Narrator audio file metadata properties');
			}
			return 'none';
		}

		if (typeof storedHash !== 'string') return 'outdated';
		const content = await this.app.vault.cachedRead(file);
		// A hash saved since 1.1 is versioned and only ever compared with the current algorithm. Falling back
		// to the 1.0.0 one for it too would briefly undo reading frontmatter from the text: right after a
		// property edit, the cache-based 1.0.0 hash still matches until Obsidian re-indexes the note.
		const currentHash = storedHash.startsWith(HASH_VERSION_PREFIX) ? this.stalenessHash(content, file) : this.legacyStalenessHash(content, file);
		return storedHash === currentHash ? 'up-to-date' : 'outdated';
	}

	/** Info about a note's linked saved audio, for the player view's "Play saved"/"Regenerate" buttons. Null if none exists. */
	async getAudioInfo(file: TFile): Promise<{ audioFile: TFile; status: AudioLinkStatus; savedVoice: string | undefined } | null> {
		const audioFile = this.findExistingAudioFile(file);
		if (!audioFile) return null;

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const savedVoice = frontmatter?.[this.settings.audioVoiceProperty] as string | undefined;
		const status = await this.getAudioStatus(file);
		return { audioFile, status, savedVoice };
	}

	private resolveSaveFolder(sourceFile: TFile | null): string {
		if (this.settings.saveAudioLocation === 'custom-folder') {
			const cleaned = cleanVaultFolderPath(this.settings.saveAudioFolderPath, this.app.vault.configDir);
			// A hand-edited data.json can hold a path the settings field would have rejected; fall back rather than write there.
			return normalizePath(cleaned.ok ? cleaned.path || '/' : DEFAULT_SETTINGS.saveAudioFolderPath);
		}
		return sourceFile?.parent?.path ?? '/';
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		if (!folderPath || folderPath === '/') return;
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	private async uniquePath(folder: string, baseName: string, extension: string): Promise<string> {
		const base = folder && folder !== '/' ? `${folder}/${baseName}` : baseName;
		let candidate = normalizePath(`${base}.${extension}`);
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${base} (${counter}).${extension}`);
			counter++;
		}
		return candidate;
	}
}
