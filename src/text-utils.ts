/** Strips common Markdown syntax so TTS reads prose instead of literal symbols. */
export function stripMarkdown(markdown: string): string {
	let text = markdown.replace(/\r\n/g, '\n');

	text = text.replace(/^---\n[\s\S]*?\n---(\n|$)/, '');
	text = text.replace(/```[\s\S]*?```/g, '');
	text = text.replace(/`([^`]+)`/g, '$1');
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
	text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/^#{1,6}\s+/gm, '');
	text = text.replace(/^\s*>\s?/gm, '');
	text = text.replace(/^\s*[-*+]\s+/gm, '');
	text = text.replace(/^\s*\d+\.\s+/gm, '');
	text = text.replace(/(\*\*\*|___)(.*?)\1/g, '$2');
	text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
	text = text.replace(/\*([^*\n]+)\*/g, '$1');
	text = text.replace(/_([^_\n]+)_/g, '$1');
	text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
	text = text.replace(/==([^=]+)==/g, '$1');

	return text;
}

/** Splits text into chunks no longer than maxLength, breaking on sentence boundaries where possible. */
export function chunkText(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text];

	const sentences = text.replace(/([.!?])\s+/g, '$1\u0000').split('\u0000');
	const chunks: string[] = [];
	let current = '';

	for (const sentence of sentences) {
		if (sentence.length > maxLength) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			let remaining = sentence;
			while (remaining.length > maxLength) {
				let splitAt = remaining.lastIndexOf(' ', maxLength);
				if (splitAt <= 0) splitAt = maxLength;
				chunks.push(remaining.slice(0, splitAt));
				remaining = remaining.slice(splitAt).trimStart();
			}
			current = remaining;
			continue;
		}

		const candidate = current ? `${current} ${sentence}` : sentence;
		if (candidate.length > maxLength) {
			chunks.push(current);
			current = sentence;
		} else {
			current = candidate;
		}
	}

	if (current) chunks.push(current);
	return chunks;
}
