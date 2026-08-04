import Anthropic from '@anthropic-ai/sdk';

/**
 * AI assessment engine (spec §6). Produces a STRUCTURED DRAFT assessment for a
 * PV reviewer to accept/override — never a final regulatory action. The model
 * version is returned so it can be persisted per assessment for reproducibility.
 *
 * When ANTHROPIC_API_KEY is unset (e.g. local dev), a deterministic mock is
 * returned so the full review/sign-off flow is exercisable without API cost.
 * The mock is clearly labelled via modelVersion.
 */
export interface FieldConfidence {
  [fieldKey: string]: 'high' | 'medium' | 'low';
}
export interface AssessmentResult {
  modelVersion: string;
  seriousness: string;
  meddraPt: string;
  meddraCode: string;
  soc: string;
  causality: string;
  causalityMethod: string;
  expectedness: string;
  regulatoryRequired: string;
  regulatoryTimeline: string;
  authorities: string[];
  narrative: string;
  confidence: FieldConfidence;
}

// Current Sonnet-tier model (the old claude-sonnet-4-* is being retired).
// Override with ANTHROPIC_MODEL (e.g. "claude-opus-5") if you want a different tier.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const SYSTEM = `You are a pharmacovigilance specialist producing a STRUCTURED DRAFT assessment of an adverse-event source document. Your output is a draft for a qualified PV reviewer to accept or override — it is never a final regulatory action. Respond with ONLY a JSON object, no prose.`;

function buildPrompt(sourceText: string): string {
  return `Assess the following adverse-event source document and return this exact JSON shape:
{
  "seriousness": "Serious | Non-serious",
  "meddraPt": "MedDRA Preferred Term",
  "meddraCode": "MedDRA PT code",
  "soc": "System Organ Class",
  "causality": "unassessable | unlikely | possible | probable | certain",
  "causalityMethod": "e.g. WHO-UMC",
  "expectedness": "Expected | Unexpected",
  "regulatoryRequired": "Yes | No",
  "regulatoryTimeline": "e.g. 15-day | 7-day | Not required",
  "authorities": ["FDA", "EMA"],
  "narrative": "2-4 sentence clinical narrative",
  "confidence": { "seriousness": "high|medium|low", "meddraPt": "...", "causality": "...", "expectedness": "...", "regulatoryRequired": "..." }
}

SOURCE DOCUMENT:
"""
${sourceText}
"""`;
}

function extractJson(text: string): any {
  const cleaned = text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

/** Deterministic draft used when no API key is configured. */
function mockAssessment(sourceText: string): AssessmentResult {
  const s = sourceText.toLowerCase();
  const serious = /death|died|hospital|life-threat|disab|congenital|seizure|anaphyla/.test(s);
  return {
    modelVersion: 'mock-dev-0',
    seriousness: serious ? 'Serious' : 'Non-serious',
    meddraPt: /headache/.test(s) ? 'Headache' : /nausea/.test(s) ? 'Nausea' : 'Adverse drug reaction',
    meddraCode: /headache/.test(s) ? '10019211' : '10061014',
    soc: /headache|seizure|dizz/.test(s) ? 'Nervous system disorders' : 'General disorders and administration site conditions',
    causality: 'possible',
    causalityMethod: 'WHO-UMC',
    expectedness: 'Unexpected',
    regulatoryRequired: serious ? 'Yes' : 'No',
    regulatoryTimeline: serious ? '15-day' : 'Not required',
    authorities: serious ? ['FDA', 'EMA'] : [],
    narrative:
      'Draft narrative (mock): patient experienced the reported event following product administration; temporal association noted. Reviewer to confirm clinical details and causality.',
    confidence: {
      seriousness: serious ? 'high' : 'medium',
      meddraPt: /headache|nausea/.test(s) ? 'high' : 'low',
      causality: 'medium',
      expectedness: 'low',
      regulatoryRequired: serious ? 'high' : 'medium',
    },
  };
}

export async function generateAssessment(sourceText: string): Promise<AssessmentResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return mockAssessment(sourceText);

  const anthropic = new Anthropic({ apiKey });
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(sourceText) }],
  });
  // Find the text block (the response may lead with a thinking block).
  const textBlock = msg.content.find((b: any) => b.type === 'text') as { type: 'text'; text: string } | undefined;
  if (!textBlock) throw new Error('No text content in AI response');
  const parsed = extractJson(textBlock.text);
  return {
    modelVersion: MODEL,
    seriousness: String(parsed.seriousness ?? ''),
    meddraPt: String(parsed.meddraPt ?? ''),
    meddraCode: String(parsed.meddraCode ?? ''),
    soc: String(parsed.soc ?? ''),
    causality: String(parsed.causality ?? ''),
    causalityMethod: String(parsed.causalityMethod ?? 'WHO-UMC'),
    expectedness: String(parsed.expectedness ?? ''),
    regulatoryRequired: String(parsed.regulatoryRequired ?? ''),
    regulatoryTimeline: String(parsed.regulatoryTimeline ?? ''),
    authorities: Array.isArray(parsed.authorities) ? parsed.authorities.map(String) : [],
    narrative: String(parsed.narrative ?? ''),
    confidence: (parsed.confidence ?? {}) as FieldConfidence,
  };
}

/** The reviewable field keys, in display order, with human labels. */
export const ASSESSMENT_FIELDS: { key: keyof AssessmentResult; label: string }[] = [
  { key: 'seriousness', label: 'Seriousness' },
  { key: 'meddraPt', label: 'MedDRA Preferred Term' },
  { key: 'meddraCode', label: 'MedDRA Code' },
  { key: 'soc', label: 'System Organ Class' },
  { key: 'causality', label: 'Causality' },
  { key: 'expectedness', label: 'Expectedness' },
  { key: 'regulatoryRequired', label: 'Regulatory Reporting Required' },
  { key: 'regulatoryTimeline', label: 'Reporting Timeline' },
  { key: 'narrative', label: 'Narrative' },
];
