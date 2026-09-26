import { setIcon } from 'obsidian';
import { queuePosition } from '../engine/background-job';
import type { BackgroundJobInfo } from '../engine/background-job';
import type { Reader } from '../engine/reader';
import { ReaderState } from '../engine/reader-types';
import type { NoteNarratorSettings } from '../settings/settings';
import { attachTooltip } from './touch-tooltip';

/** The player view's list of queued/generating/finished background jobs, drawn in the style chosen in settings. */
export class BackgroundJobList {
	constructor(
		private readonly reader: Reader,
		private readonly settings: NoteNarratorSettings,
	) {}

	/** Label text for a background job's current status, per {@link BackgroundJobInfo.status}. */
	private backgroundJobLabel(job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): string {
		const name = job.file?.basename ?? 'note';
		if (job.status === 'done') return `Finished generating in background: ${name}`;
		if (job.status === 'queued') return `Queued to generate in background: ${name} (#${queuePosition(allJobs, job.id)})`;
		const readyCount = job.chunkReady.filter(Boolean).length;
		return `Generating in background: ${name} — ${readyCount}/${job.chunkCount} parts`;
	}

	private backgroundJobIcon(job: BackgroundJobInfo): string {
		if (job.status === 'done') return 'check-circle-2';
		if (job.status === 'queued') return 'list-ordered';
		return 'loader-2';
	}

	/** "X" for clearing a finished job from the list -- a trash can there would read as deleting the generated audio, not just the list entry. Queued/generating jobs still get the trash can, since discarding those really does cancel/throw away in-progress work. */
	private backgroundJobRemoveIcon(job: BackgroundJobInfo): string {
		return job.status === 'done' ? 'x' : 'trash-2';
	}

	private backgroundJobRemoveLabel(job: BackgroundJobInfo): string {
		return job.status === 'done' ? 'Clear from list' : 'Discard background generation';
	}

	/** Makes a background-job row/card play that job on click or on Enter/Space when focused, like a real button. */
	private makeBackgroundJobClickable(el: HTMLElement, jobId: number): void {
		el.setAttribute('role', 'button');
		el.setAttribute('tabindex', '0');
		el.onclick = () => this.reader.playBackgroundJob(jobId);
		el.onkeydown = (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;
			evt.preventDefault();
			this.reader.playBackgroundJob(jobId);
		};
	}

	/** Small icon button for a background-job row/card, stopping the click from bubbling up to the row's own "play this" click handler. */
	private createBackgroundJobIconButton(container: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const button = container.createDiv({ cls: 'clickable-icon note-narrator-bgjob-icon-button' });
		setIcon(button, icon);
		attachTooltip(button, label);
		button.onclick = (evt) => {
			evt.stopPropagation();
			onClick();
		};
		return button;
	}

	private renderBackgroundGenerationBar(container: HTMLElement, job: BackgroundJobInfo): void {
		const bar = container.createDiv({ cls: 'note-narrator-generation-bar' });
		for (let i = 0; i < job.chunkCount; i++) {
			const segment = bar.createDiv({ cls: 'note-narrator-generation-segment' });
			if (job.chunkReady[i]) segment.addClass('is-ready');
			else if (job.chunkInFlight[i]) segment.addClass('is-generating');
		}
	}

	/** Shows every note queued/generating/finished in the background, in the style chosen by the "Background job display" setting. Clicking anywhere on a row/card besides its own buttons plays that note. */
	render(container: HTMLElement, state: ReaderState): void {
		if (state.backgroundJobs.length === 0) return;

		const list = container.createDiv({ cls: 'note-narrator-background-jobs' });
		const style = this.settings.backgroundJobDisplayStyle;
		for (const job of state.backgroundJobs) {
			if (style === 'full') this.renderBackgroundJobFull(list, job, state.backgroundJobs);
			else if (style === 'compact') this.renderBackgroundJobCompact(list, job, state.backgroundJobs);
			else this.renderBackgroundJobMinimal(list, job, state.backgroundJobs);
		}
	}

	private renderBackgroundJobFull(container: HTMLElement, job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): void {
		const box = container.createDiv({ cls: 'note-narrator-background-job note-narrator-background-job--full' });
		box.addClass(`is-${job.status}`);
		this.makeBackgroundJobClickable(box, job.id);

		const header = box.createDiv({ cls: 'note-narrator-background-job-header' });
		header.createSpan({ cls: 'note-narrator-background-job-icon' }, (el) => setIcon(el, this.backgroundJobIcon(job)));
		header.createSpan({ text: this.backgroundJobLabel(job, allJobs) });

		this.renderBackgroundGenerationBar(box, job);

		const actions = box.createDiv({ cls: 'note-narrator-background-job-actions' });
		const playButton = actions.createEl('button', { cls: 'mod-cta', text: 'Play' });
		playButton.onclick = (evt) => {
			evt.stopPropagation();
			this.reader.playBackgroundJob(job.id);
		};

		const discardButton = actions.createDiv({ cls: 'clickable-icon note-narrator-background-job-discard' });
		setIcon(discardButton, this.backgroundJobRemoveIcon(job));
		attachTooltip(discardButton, this.backgroundJobRemoveLabel(job));
		discardButton.onclick = (evt) => {
			evt.stopPropagation();
			this.reader.discardBackgroundJob(job.id);
		};
	}

	private renderBackgroundJobCompact(container: HTMLElement, job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): void {
		const row = container.createDiv({ cls: 'note-narrator-background-job note-narrator-background-job--compact' });
		row.addClass(`is-${job.status}`);
		attachTooltip(row, this.backgroundJobLabel(job, allJobs));
		this.makeBackgroundJobClickable(row, job.id);

		row.createSpan({ cls: 'note-narrator-background-job-icon' }, (el) => setIcon(el, this.backgroundJobIcon(job)));
		row.createSpan({ cls: 'note-narrator-background-job-name', text: job.file?.basename ?? 'note' });

		const bar = row.createDiv({ cls: 'note-narrator-background-job-minibar' });
		for (let i = 0; i < job.chunkCount; i++) {
			const segment = bar.createDiv();
			if (job.chunkReady[i]) segment.addClass('is-ready');
		}

		this.createBackgroundJobIconButton(row, 'play', 'Play', () => this.reader.playBackgroundJob(job.id));
		this.createBackgroundJobIconButton(row, this.backgroundJobRemoveIcon(job), this.backgroundJobRemoveLabel(job), () =>
			this.reader.discardBackgroundJob(job.id),
		);
	}

	private renderBackgroundJobMinimal(container: HTMLElement, job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): void {
		const card = container.createDiv({ cls: 'note-narrator-background-job note-narrator-background-job--minimal' });
		card.addClass(`is-${job.status}`);
		attachTooltip(card, this.backgroundJobLabel(job, allJobs));
		this.makeBackgroundJobClickable(card, job.id);

		const titleRow = card.createDiv({ cls: 'note-narrator-background-job-title-row' });
		titleRow.createSpan({ cls: 'note-narrator-background-job-icon' }, (el) => setIcon(el, this.backgroundJobIcon(job)));
		titleRow.createSpan({ cls: 'note-narrator-background-job-name', text: job.file?.basename ?? 'note' });

		const buttons = titleRow.createDiv({ cls: 'note-narrator-background-job-minimal-buttons' });
		this.createBackgroundJobIconButton(buttons, 'play', 'Play', () => this.reader.playBackgroundJob(job.id));
		this.createBackgroundJobIconButton(buttons, this.backgroundJobRemoveIcon(job), this.backgroundJobRemoveLabel(job), () =>
			this.reader.discardBackgroundJob(job.id),
		);

		this.renderBackgroundGenerationBar(card, job);
	}
}
