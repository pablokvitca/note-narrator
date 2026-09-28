/*
 * Static data about Amazon Polly's REST API: its synthesis engines, its documented voice list (with which
 * engine(s) each voice supports), its service regions, and its per-request text limit.
 *
 * Polly's voice list is stable and documented (not typically fetched live like ElevenLabs' account-scoped
 * voices are) -- see https://docs.aws.amazon.com/polly/latest/dg/voicelist.html, verified 2026-09-28. A
 * `DescribeVoices` API does exist for fetching it live per-account, but nothing about Polly's voices is
 * account-specific (unlike ElevenLabs, where the voice list *is* the account's own cloned/library voices),
 * so a static list avoids a network round trip for something that rarely changes.
 */

export type AWSEngine = 'standard' | 'neural' | 'long-form' | 'generative';

export const AWS_ENGINE_LABELS: Record<AWSEngine, string> = {
	standard: 'Standard',
	neural: 'Neural',
	'long-form': 'Long-form',
	generative: 'Generative',
};

export interface AWSVoice {
	voiceId: string;
	name: string;
	languageCode: string;
	languageName: string;
	gender: string;
	engines: AWSEngine[];
}

/** Amazon Polly's documented voice list (https://docs.aws.amazon.com/polly/latest/dg/voicelist.html), with each voice's supported engine(s). Excludes custom "Brand Voice" voices, which aren't offered to every account. */
export const AWS_POLLY_VOICES: AWSVoice[] = [
	{ voiceId: 'Zeina', name: 'Zeina', languageCode: 'arb', languageName: 'Arabic', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Hala', name: 'Hala', languageCode: 'ar-AE', languageName: 'Arabic (Gulf)', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Zayd', name: 'Zayd', languageCode: 'ar-AE', languageName: 'Arabic (Gulf)', gender: 'Male', engines: ['neural'] },
	{ voiceId: 'Lisa', name: 'Lisa', languageCode: 'nl-BE', languageName: 'Dutch (Belgian)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Arlet', name: 'Arlet', languageCode: 'ca-ES', languageName: 'Catalan', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Jitka', name: 'Jitka', languageCode: 'cs-CZ', languageName: 'Czech', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Hiujin', name: 'Hiujin', languageCode: 'yue-CN', languageName: 'Chinese (Cantonese)', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Zhiyu', name: 'Zhiyu', languageCode: 'cmn-CN', languageName: 'Chinese (Mandarin)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Naja', name: 'Naja', languageCode: 'da-DK', languageName: 'Danish', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Mads', name: 'Mads', languageCode: 'da-DK', languageName: 'Danish', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Sofie', name: 'Sofie', languageCode: 'da-DK', languageName: 'Danish', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Laura', name: 'Laura', languageCode: 'nl-NL', languageName: 'Dutch', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Lotte', name: 'Lotte', languageCode: 'nl-NL', languageName: 'Dutch', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Ruben', name: 'Ruben', languageCode: 'nl-NL', languageName: 'Dutch', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Nicole', name: 'Nicole', languageCode: 'en-AU', languageName: 'English (Australian)', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Olivia', name: 'Olivia', languageCode: 'en-AU', languageName: 'English (Australian)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Russell', name: 'Russell', languageCode: 'en-AU', languageName: 'English (Australian)', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Amy', name: 'Amy', languageCode: 'en-GB', languageName: 'English (British)', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Emma', name: 'Emma', languageCode: 'en-GB', languageName: 'English (British)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Brian', name: 'Brian', languageCode: 'en-GB', languageName: 'English (British)', gender: 'Male', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Arthur', name: 'Arthur', languageCode: 'en-GB', languageName: 'English (British)', gender: 'Male', engines: ['neural'] },
	{ voiceId: 'Aditi', name: 'Aditi (bilingual: en-IN/hi-IN)', languageCode: 'en-IN', languageName: 'English (Indian)', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Raveena', name: 'Raveena', languageCode: 'en-IN', languageName: 'English (Indian)', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Kajal', name: 'Kajal (bilingual: en-IN/hi-IN)', languageCode: 'en-IN', languageName: 'English (Indian)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Niamh', name: 'Niamh', languageCode: 'en-IE', languageName: 'English (Ireland)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Aria', name: 'Aria', languageCode: 'en-NZ', languageName: 'English (New Zealand)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Jasmine', name: 'Jasmine', languageCode: 'en-SG', languageName: 'English (Singaporean)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Ayanda', name: 'Ayanda', languageCode: 'en-ZA', languageName: 'English (South African)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Danielle', name: 'Danielle', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['generative', 'long-form', 'neural'] },
	{ voiceId: 'Gregory', name: 'Gregory', languageCode: 'en-US', languageName: 'English (US)', gender: 'Male', engines: ['generative', 'long-form', 'neural'] },
	{ voiceId: 'Ivy', name: 'Ivy (child)', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['long-form', 'neural', 'standard'] },
	{ voiceId: 'Joanna', name: 'Joanna', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Kendra', name: 'Kendra', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Kimberly', name: 'Kimberly', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Salli', name: 'Salli', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Joey', name: 'Joey', languageCode: 'en-US', languageName: 'English (US)', gender: 'Male', engines: ['neural', 'standard'] },
	{ voiceId: 'Justin', name: 'Justin (child)', languageCode: 'en-US', languageName: 'English (US)', gender: 'Male', engines: ['neural'] },
	{ voiceId: 'Kevin', name: 'Kevin (child)', languageCode: 'en-US', languageName: 'English (US)', gender: 'Male', engines: ['neural', 'standard'] },
	{ voiceId: 'Matthew', name: 'Matthew', languageCode: 'en-US', languageName: 'English (US)', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Ruth', name: 'Ruth', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['generative', 'long-form', 'neural'] },
	{ voiceId: 'Stephen', name: 'Stephen', languageCode: 'en-US', languageName: 'English (US)', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Tiffany', name: 'Tiffany', languageCode: 'en-US', languageName: 'English (US)', gender: 'Female', engines: ['generative'] },
	{ voiceId: 'Patrick', name: 'Patrick', languageCode: 'en-US', languageName: 'English (US)', gender: 'Male', engines: ['long-form'] },
	{ voiceId: 'Geraint', name: 'Geraint', languageCode: 'en-GB-WLS', languageName: 'English (Welsh)', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Suvi', name: 'Suvi', languageCode: 'fi-FI', languageName: 'Finnish', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Ambre', name: 'Ambre', languageCode: 'fr-FR', languageName: 'French', gender: 'Female', engines: ['generative'] },
	{ voiceId: 'Celine', name: 'Céline', languageCode: 'fr-FR', languageName: 'French', gender: 'Female', engines: ['generative', 'standard'] },
	{ voiceId: 'Florian', name: 'Florian', languageCode: 'fr-FR', languageName: 'French', gender: 'Male', engines: ['generative'] },
	{ voiceId: 'Lea', name: 'Léa', languageCode: 'fr-FR', languageName: 'French', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Mathieu', name: 'Mathieu', languageCode: 'fr-FR', languageName: 'French', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Remi', name: 'Rémi', languageCode: 'fr-FR', languageName: 'French', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Isabelle', name: 'Isabelle', languageCode: 'fr-BE', languageName: 'French (Belgian)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Chantal', name: 'Chantal', languageCode: 'fr-CA', languageName: 'French (Canadian)', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Gabrielle', name: 'Gabrielle', languageCode: 'fr-CA', languageName: 'French (Canadian)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Liam', name: 'Liam', languageCode: 'fr-CA', languageName: 'French (Canadian)', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Marlene', name: 'Marlene', languageCode: 'de-DE', languageName: 'German', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Vicki', name: 'Vicki', languageCode: 'de-DE', languageName: 'German', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Hans', name: 'Hans', languageCode: 'de-DE', languageName: 'German', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Daniel', name: 'Daniel', languageCode: 'de-DE', languageName: 'German', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Lennart', name: 'Lennart', languageCode: 'de-DE', languageName: 'German', gender: 'Male', engines: ['generative'] },
	{ voiceId: 'Hannah', name: 'Hannah', languageCode: 'de-AT', languageName: 'German (Austrian)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Sabrina', name: 'Sabrina', languageCode: 'de-CH', languageName: 'German (Swiss)', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Kajal', name: 'Kajal (bilingual: hi-IN/en-IN)', languageCode: 'hi-IN', languageName: 'Hindi', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Dora', name: 'Dóra', languageCode: 'is-IS', languageName: 'Icelandic', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Karl', name: 'Karl', languageCode: 'is-IS', languageName: 'Icelandic', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Beatrice', name: 'Beatrice', languageCode: 'it-IT', languageName: 'Italian', gender: 'Female', engines: ['generative'] },
	{ voiceId: 'Carla', name: 'Carla', languageCode: 'it-IT', languageName: 'Italian', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Bianca', name: 'Bianca', languageCode: 'it-IT', languageName: 'Italian', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Lorenzo', name: 'Lorenzo', languageCode: 'it-IT', languageName: 'Italian', gender: 'Male', engines: ['generative'] },
	{ voiceId: 'Giorgio', name: 'Giorgio', languageCode: 'it-IT', languageName: 'Italian', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Adriano', name: 'Adriano', languageCode: 'it-IT', languageName: 'Italian', gender: 'Male', engines: ['neural'] },
	{ voiceId: 'Mizuki', name: 'Mizuki', languageCode: 'ja-JP', languageName: 'Japanese', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Takumi', name: 'Takumi', languageCode: 'ja-JP', languageName: 'Japanese', gender: 'Male', engines: ['neural', 'standard'] },
	{ voiceId: 'Kazuha', name: 'Kazuha', languageCode: 'ja-JP', languageName: 'Japanese', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Tomoko', name: 'Tomoko', languageCode: 'ja-JP', languageName: 'Japanese', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Seoyeon', name: 'Seoyeon', languageCode: 'ko-KR', languageName: 'Korean', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Jihye', name: 'Jihye', languageCode: 'ko-KR', languageName: 'Korean', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Liv', name: 'Liv', languageCode: 'nb-NO', languageName: 'Norwegian', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Ida', name: 'Ida', languageCode: 'nb-NO', languageName: 'Norwegian', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Ewa', name: 'Ewa', languageCode: 'pl-PL', languageName: 'Polish', gender: 'Female', engines: ['generative', 'standard'] },
	{ voiceId: 'Maja', name: 'Maja', languageCode: 'pl-PL', languageName: 'Polish', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Jacek', name: 'Jacek', languageCode: 'pl-PL', languageName: 'Polish', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Jan', name: 'Jan', languageCode: 'pl-PL', languageName: 'Polish', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Ola', name: 'Ola', languageCode: 'pl-PL', languageName: 'Polish', gender: 'Female', engines: ['generative', 'neural'] },
	{ voiceId: 'Camila', name: 'Camila', languageCode: 'pt-BR', languageName: 'Portuguese (Brazilian)', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Vitoria', name: 'Vitória', languageCode: 'pt-BR', languageName: 'Portuguese (Brazilian)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Ricardo', name: 'Ricardo', languageCode: 'pt-BR', languageName: 'Portuguese (Brazilian)', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Thiago', name: 'Thiago', languageCode: 'pt-BR', languageName: 'Portuguese (Brazilian)', gender: 'Male', engines: ['neural'] },
	{ voiceId: 'Ines', name: 'Inês', languageCode: 'pt-PT', languageName: 'Portuguese (European)', gender: 'Female', engines: ['neural', 'standard'] },
	{ voiceId: 'Cristiano', name: 'Cristiano', languageCode: 'pt-PT', languageName: 'Portuguese (European)', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Carmen', name: 'Carmen', languageCode: 'ro-RO', languageName: 'Romanian', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Tatyana', name: 'Tatyana', languageCode: 'ru-RU', languageName: 'Russian', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Maxim', name: 'Maxim', languageCode: 'ru-RU', languageName: 'Russian', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Conchita', name: 'Conchita', languageCode: 'es-ES', languageName: 'Spanish (Spain)', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Lucia', name: 'Lucía', languageCode: 'es-ES', languageName: 'Spanish (Spain)', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Alba', name: 'Alba', languageCode: 'es-ES', languageName: 'Spanish (Spain)', gender: 'Female', engines: ['long-form'] },
	{ voiceId: 'Enrique', name: 'Enrique', languageCode: 'es-ES', languageName: 'Spanish (Spain)', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Sergio', name: 'Sergio', languageCode: 'es-ES', languageName: 'Spanish (Spain)', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Raul', name: 'Raúl', languageCode: 'es-ES', languageName: 'Spanish (Spain)', gender: 'Male', engines: ['long-form'] },
	{ voiceId: 'Mia', name: 'Mia', languageCode: 'es-MX', languageName: 'Spanish (Mexican)', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Andres', name: 'Andrés', languageCode: 'es-MX', languageName: 'Spanish (Mexican)', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Lupe', name: 'Lupe', languageCode: 'es-US', languageName: 'Spanish (US)', gender: 'Female', engines: ['generative', 'neural', 'standard'] },
	{ voiceId: 'Penelope', name: 'Penélope', languageCode: 'es-US', languageName: 'Spanish (US)', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Miguel', name: 'Miguel', languageCode: 'es-US', languageName: 'Spanish (US)', gender: 'Male', engines: ['standard'] },
	{ voiceId: 'Pedro', name: 'Pedro', languageCode: 'es-US', languageName: 'Spanish (US)', gender: 'Male', engines: ['generative', 'neural'] },
	{ voiceId: 'Astrid', name: 'Astrid', languageCode: 'sv-SE', languageName: 'Swedish', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Elin', name: 'Elin', languageCode: 'sv-SE', languageName: 'Swedish', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Filiz', name: 'Filiz', languageCode: 'tr-TR', languageName: 'Turkish', gender: 'Female', engines: ['standard'] },
	{ voiceId: 'Burcu', name: 'Burcu', languageCode: 'tr-TR', languageName: 'Turkish', gender: 'Female', engines: ['neural'] },
	{ voiceId: 'Gwyneth', name: 'Gwyneth', languageCode: 'cy-GB', languageName: 'Welsh', gender: 'Female', engines: ['standard'] },
];

export const DEFAULT_AWS_VOICE_ID = 'Joanna';
export const DEFAULT_AWS_ENGINE: AWSEngine = 'neural';
export const DEFAULT_AWS_REGION = 'us-east-1';

/**
 * Polly's `SynthesizeSpeech` REST endpoint caps input at 6,000 total characters, of which at most 3,000 may
 * be "billed" characters (SSML tags don't count) -- the same quota for every engine, unlike ElevenLabs'
 * per-model limits. The plugin only ever sends plain text (no SSML), so its whole input counts as billed;
 * 3,000 is therefore the effective per-request limit. Both figures are adjustable per-account service
 * quotas, but 3,000 is the conservative documented default.
 * https://docs.aws.amazon.com/general/latest/gr/pol.html#limits_polly (verified 2026-09-28)
 */
export const AWS_CHAR_LIMIT = 3000;

/** Polly's service (non-FIPS, non-GovCloud) regions and display names, for the provider's region field. https://docs.aws.amazon.com/general/latest/gr/pol.html (verified 2026-09-28) */
export const AWS_POLLY_REGIONS: Record<string, string> = {
	'us-east-1': 'US East (N. Virginia)',
	'us-east-2': 'US East (Ohio)',
	'us-west-1': 'US West (N. California)',
	'us-west-2': 'US West (Oregon)',
	'af-south-1': 'Africa (Cape Town)',
	'ap-east-1': 'Asia Pacific (Hong Kong)',
	'ap-southeast-5': 'Asia Pacific (Malaysia)',
	'ap-south-1': 'Asia Pacific (Mumbai)',
	'ap-northeast-3': 'Asia Pacific (Osaka)',
	'ap-northeast-2': 'Asia Pacific (Seoul)',
	'ap-southeast-1': 'Asia Pacific (Singapore)',
	'ap-southeast-2': 'Asia Pacific (Sydney)',
	'ap-southeast-7': 'Asia Pacific (Thailand)',
	'ap-northeast-1': 'Asia Pacific (Tokyo)',
	'ca-central-1': 'Canada (Central)',
	'eu-central-1': 'Europe (Frankfurt)',
	'eu-west-1': 'Europe (Ireland)',
	'eu-west-2': 'Europe (London)',
	'eu-west-3': 'Europe (Paris)',
	'eu-south-2': 'Europe (Spain)',
	'eu-north-1': 'Europe (Stockholm)',
	'eu-central-2': 'Europe (Zurich)',
	'me-south-1': 'Middle East (Bahrain)',
	'sa-east-1': 'South America (São Paulo)',
};

export function awsVoicesForEngine(engine: AWSEngine): AWSVoice[] {
	return AWS_POLLY_VOICES.filter((voice) => voice.engines.includes(engine));
}

export function findAwsVoice(voiceId: string): AWSVoice | undefined {
	return AWS_POLLY_VOICES.find((voice) => voice.voiceId === voiceId);
}
