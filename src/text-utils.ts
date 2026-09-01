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
	text = text.replace(/(?<![*\w])\*(?!\s)(.*?)(?<!\s)\*(?!\*)/g, '$1');
	text = text.replace(/(?<![_\w])_(?!\s)(.*?)(?<!\s)_(?!_)/g, '$1');
	text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
	text = text.replace(/==([^=]+)==/g, '$1');

	return text;
}
