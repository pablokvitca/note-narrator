import { App, TFile } from 'obsidian';
import { ChunkPosition, computeChunkPositions, rebaseSpan, splitChunkPosition } from '../text/text-position';
import { NULL_CHUNK_POSITION, PositionBase } from './reader-types';
import { NoteNarratorSettings, getGlobalReadingConfig } from '../settings/settings';
import { ReadingConfig, ResolvedNarrator, getActiveProfile, providerCharLimit, resolveNarrator, resolveReadingConfig } from '../settings/profiles';
import { StripMarkdownOptions, buildReadingPreamble, chunkBySentence, chunkByWordCount, chunkNote, parseHeadingSkipPatterns, stripFrontmatter } from '../text/text-utils';

/**
 * Turns a note into what gets spoken: the reading settings in effect (global defaults plus the active narrator
 * profile's overrides), the title and properties preamble, and the chunks (with their estimated editor
 * positions) each TTS request will carry. Shared by reading, saved-audio playback and the panel's note stats.
 */
export class NoteText {
	constructor(
		private app: App,
		private settings: NoteNarratorSettings,
	) {}

	/** The reading settings in effect: the global defaults with the active narrator profile's overrides applied. */
	getReadingConfig(): ReadingConfig {
		return resolveReadingConfig(getGlobalReadingConfig(this.settings), getActiveProfile(this.settings)?.readingOverrides);
	}

	/** The active narrator profile resolved with its provider, or null when none is usable. */
	getActiveNarrator(): ResolvedNarrator | null {
		return resolveNarrator(this.settings);
	}

	buildPreamble(title: string | null, frontmatter: Parameters<typeof buildReadingPreamble>[1], body: string): string {
		const reading = this.getReadingConfig();
		return buildReadingPreamble(title, frontmatter, body, {
			readTitle: reading.readTitle,
			readProperties: reading.readProperties,
			skipTitleWhenMatchingHeading: reading.skipTitleWhenMatchingHeading,
		});
	}

	getStripMarkdownOptions(): StripMarkdownOptions {
		const reading = this.getReadingConfig();
		return {
			stripMarkdownComments: reading.stripMarkdownComments,
			stripCommentDelimiters: reading.stripCommentDelimiters,
			announceComments: reading.announceComments,
		};
	}

	/** Characters one TTS request can hold for the active narrator's voice configuration. */
	getCharLimit(): number {
		return providerCharLimit(this.getActiveNarrator()?.voice);
	}

	getSkipHeadingPatterns(): RegExp[] {
		return parseHeadingSkipPatterns(this.getReadingConfig().skipSectionHeadingPatterns);
	}

	private rebasePosition(position: ChunkPosition, base: PositionBase): ChunkPosition {
		return {
			span: rebaseSpan(position.span, base.rawTextOffset, base.length, base.fileOffset),
			sectionSpan: rebaseSpan(position.sectionSpan, base.rawTextOffset, base.length, base.fileOffset),
			sectionHeadingSpan: rebaseSpan(position.sectionHeadingSpan, base.rawTextOffset, base.length, base.fileOffset),
		};
	}

	/**
	 * The chunking + position-estimation pipeline shared by an actual read (`readText()`) and re-deriving
	 * the same structure later for a saved file's playback (`buildSavedPlaybackTimeline()`) -- kept as one
	 * implementation so the two can't silently drift apart (e.g. one applying quick-start's chunk-0 split
	 * and the other not, which would misalign a saved file's chunk index against its content).
	 */
	buildChunksAndPositions(rawText: string, positionBase: PositionBase | undefined): { chunks: string[]; positions: ChunkPosition[] } {
		const charLimit = this.getCharLimit();
		const built = computeChunkPositions(
			rawText,
			charLimit,
			this.getReadingConfig().chunkerStyle,
			this.getReadingConfig().maxHeadingDepth,
			this.getStripMarkdownOptions(),
			this.getSkipHeadingPatterns(),
			// The preamble (with its separator) is exactly what comes before the note body.
			positionBase?.rawTextOffset ?? 0,
		);
		let chunks = built.chunks;
		let positions = positionBase
			? built.positions.map((position) => this.rebasePosition(position, positionBase))
			: built.positions.map(() => NULL_CHUNK_POSITION);

		// Quick start: split the first chunk into a short lead-in plus the remainder (including the
		// preamble, since it's already part of chunks[0]), so the first TTS request returns sooner.
		if (this.settings.startPlaybackImmediately && this.settings.quickStart) {
			const [firstChunk, ...rest] = chunks;
			const [firstPosition, ...restPositions] = positions;
			if (firstChunk !== undefined) {
				const leadPieces =
					this.settings.quickStartUnit === 'words'
						? chunkByWordCount(firstChunk, this.settings.quickStartWordCount)
						: chunkBySentence(firstChunk, this.settings.quickStartCharCount);
				chunks = [...leadPieces, ...rest];
				positions = [...splitChunkPosition(firstPosition, leadPieces.map((piece) => piece.length)), ...restPositions];
			}
		}

		return { chunks, positions };
	}

	/**
	 * Note-length stats for the panel's idle-state display (total characters/chunks, average per chunk),
	 * computed via the same preamble+chunking pipeline readNote() would use. Null for non-notes or notes
	 * with nothing to read.
	 */
	async getNoteStats(
		file: TFile,
	): Promise<{ totalChars: number; chunkCount: number; avgCharsPerChunk: number; avgWordsPerChunk: number } | null> {
		if (file.extension !== 'md') return null;

		const rawText = await this.app.vault.cachedRead(file);
		const body = stripFrontmatter(rawText);
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const preamble = this.buildPreamble(file.basename, frontmatter, body);
		const textToRead = preamble ? `${preamble}\n\n${body}` : body;
		if (!textToRead.trim()) return null;

		const charLimit = this.getCharLimit();
		const chunks = chunkNote(
			textToRead,
			charLimit,
			this.getReadingConfig().chunkerStyle,
			this.getReadingConfig().maxHeadingDepth,
			this.getStripMarkdownOptions(),
			this.getSkipHeadingPatterns(),
			preamble ? preamble.length + 2 : 0,
		);
		if (chunks.length === 0) return null;

		const totalChars = textToRead.length;
		const totalWords = textToRead.split(/\s+/).filter(Boolean).length;
		return {
			totalChars,
			chunkCount: chunks.length,
			avgCharsPerChunk: Math.round(totalChars / chunks.length),
			avgWordsPerChunk: Math.round(totalWords / chunks.length),
		};
	}
}
