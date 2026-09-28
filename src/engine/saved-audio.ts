import { App, Notice, TFile, moment, normalizePath } from 'obsidian';
import { AudioLinkStatus } from './reader-types';
import { cleanVaultFolderPath } from './vault-path';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from '../settings/settings';
import { ResolvedNarrator, VoiceConfig } from '../settings/profiles';
import { concatArrayBuffers, sanitizeFilenameComponent } from './audio-utils';
import { getProviderCredentials, providerOutputFormat, resolveVoiceLabel } from '../tts/registry';
import { hashText, stripFrontmatter } from '../text/text-utils';

/**
 * A note's saved audio: writing the `.mp3` next to it, linking it in the note's frontmatter, deciding whether
 * it is up to date or outdated (by hashing the note), and clearing it. Everything here goes through the vault
 * and the note's frontmatter; playback and generation live in {@link Reader}.
 */
export class SavedAudio {
	constructor(
		private app: App,
		private settings: NoteNarratorSettings,
		/** Called after a note's audio properties are written or removed, so open views can refresh. */
		private onAudioStatusChange: (file: TFile) => void,
	) {}

	async saveAudioFile(chunks: ArrayBuffer[], sourceFile: TFile | null, chunkDurations: number[], narrator: ResolvedNarrator): Promise<void> {
		try {
			const credentials = getProviderCredentials(this.app, narrator.provider);
			const voiceName = credentials ? await resolveVoiceLabel(narrator.provider, narrator.voice, credentials) : this.voiceFallbackLabel(narrator.voice);
			const format = providerOutputFormat(narrator.provider.type);
			const data = concatArrayBuffers(chunks, format);

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
				const path = await this.uniquePath(folderPath, baseName, format);
				audioFile = await this.app.vault.createBinary(path, data);
				new Notice(`Saved audio to ${path}`);
			}

			if (this.settings.linkAudioInNote && sourceFile) {
				const chunkMeta = chunkDurations.map((duration, i) => ({ duration, byteLength: chunks[i]?.byteLength ?? 0 }));
				await this.linkAudioInNote(audioFile, sourceFile, chunkMeta, narrator);
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
	 */
	private async computeStalenessHash(file: TFile): Promise<string> {
		const rawContent = await this.app.vault.cachedRead(file);
		const body = stripFrontmatter(rawContent);
		const frontmatter: Record<string, unknown> = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) };
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

	private async linkAudioInNote(audioFile: TFile, sourceFile: TFile, chunkMeta: { duration: number; byteLength: number }[], narrator: ResolvedNarrator): Promise<void> {
		const link = this.app.fileManager.generateMarkdownLink(audioFile, sourceFile.path);
		const hash = await this.computeStalenessHash(sourceFile);

		const cacheUpdated = this.waitForMetadataCacheUpdate(sourceFile);
		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			frontmatter[this.settings.audioLinkProperty] = link;
			frontmatter[this.settings.audioHashProperty] = hash;
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
		const storedHash = frontmatter?.[this.settings.audioHashProperty] as string | undefined;
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

		const currentHash = await this.computeStalenessHash(file);
		return currentHash === storedHash ? 'up-to-date' : 'outdated';
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
