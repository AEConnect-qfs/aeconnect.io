/**
 * Seed eval for the assessment draft.
 *
 * Runs five clearly fake narratives through the mock provider and scores
 * schema validity plus exact enum/field match. Also rejects a few invalid
 * drafts, and checks provider selection (including the Anthropic fallback
 * when LLM_* is unset). No network calls.
 *
 *   npm run eval
 */
import { assessCase, validateDraft, PROMPT_VERSION, resolveLlmConfig, AssessmentError, DraftValidationError } from './netlify/functions/_lib/assessment.js';

const ENUM_FIELDS = [
  'seriousness',
  'meddraPt',
  'meddraCode',
  'soc',
  'causality',
  'expectedness',
  'regulatoryRequired',
  'regulatoryTimeline',
] as const;

interface Expectation {
  seriousness: string;
  meddraPt: string;
  meddraCode: string;
  soc: string;
  causality: string;
  expectedness: string;
  regulatoryRequired: string;
  regulatoryTimeline: string;
  confidenceSeriousness: string;
  confidenceMeddra: string;
}

const FIXTURES: { id: string; text: string; expect: Expectation }[] = [
  {
    id: 'hospitalized-headache',
    text: 'SYNTHETIC FIXTURE. Not a real patient. A fictional volunteer reported headache after one dose of ExampleDrug-A 10 mg and was hospitalized overnight for observation.',
    expect: {
      seriousness: 'Serious',
      meddraPt: 'Headache',
      meddraCode: '10019211',
      soc: 'Nervous system disorders',
      causality: 'possible',
      expectedness: 'Unexpected',
      regulatoryRequired: 'Yes',
      regulatoryTimeline: '15-day',
      confidenceSeriousness: 'high',
      confidenceMeddra: 'high',
    },
  },
  {
    id: 'mild-nausea',
    text: 'SYNTHETIC FIXTURE. Not a real patient. A fictional volunteer reported nausea after ExampleDrug-B 5 mg. No other symptoms. Stayed home.',
    expect: {
      seriousness: 'Non-serious',
      meddraPt: 'Nausea',
      meddraCode: '10061014',
      soc: 'General disorders and administration site conditions',
      causality: 'possible',
      expectedness: 'Unexpected',
      regulatoryRequired: 'No',
      regulatoryTimeline: 'Not required',
      confidenceSeriousness: 'medium',
      confidenceMeddra: 'high',
    },
  },
  {
    id: 'death-after-seizure',
    text: 'SYNTHETIC FIXTURE. Not a real patient. A fictional volunteer had a seizure after ExampleDrug-C and died the same day. Invented case for the eval harness only.',
    expect: {
      seriousness: 'Serious',
      meddraPt: 'Adverse drug reaction',
      meddraCode: '10061014',
      soc: 'Nervous system disorders',
      causality: 'possible',
      expectedness: 'Unexpected',
      regulatoryRequired: 'Yes',
      regulatoryTimeline: '15-day',
      confidenceSeriousness: 'high',
      confidenceMeddra: 'low',
    },
  },
  {
    id: 'dizzy-at-home',
    text: 'SYNTHETIC FIXTURE. Not a real patient. A fictional volunteer felt dizzy for an hour after ExampleDrug-D. They stayed home and it resolved without treatment.',
    expect: {
      seriousness: 'Non-serious',
      meddraPt: 'Adverse drug reaction',
      meddraCode: '10061014',
      soc: 'Nervous system disorders',
      causality: 'possible',
      expectedness: 'Unexpected',
      regulatoryRequired: 'No',
      regulatoryTimeline: 'Not required',
      confidenceSeriousness: 'medium',
      confidenceMeddra: 'low',
    },
  },
  {
    id: 'fatigue-recovered',
    text: 'SYNTHETIC FIXTURE. Not a real patient. A fictional volunteer described mild fatigue after ExampleDrug-E and recovered at home the next morning.',
    expect: {
      seriousness: 'Non-serious',
      meddraPt: 'Adverse drug reaction',
      meddraCode: '10061014',
      soc: 'General disorders and administration site conditions',
      causality: 'possible',
      expectedness: 'Unexpected',
      regulatoryRequired: 'No',
      regulatoryTimeline: 'Not required',
      confidenceSeriousness: 'medium',
      confidenceMeddra: 'low',
    },
  },
];

const INVALID_DRAFTS: { id: string; draft: Record<string, unknown> }[] = [
  { id: 'bad-seriousness', draft: baseDraft({ seriousness: 'Maybe' }) },
  { id: 'bad-causality', draft: baseDraft({ causality: 'likely' }) },
  { id: 'bad-timeline', draft: baseDraft({ regulatoryTimeline: '30-day' }) },
  { id: 'bad-meddra-code', draft: baseDraft({ meddraCode: 'PT-headache' }) },
  { id: 'missing-narrative', draft: baseDraft({ narrative: '' }) },
];

function baseDraft(over: Record<string, unknown>): Record<string, unknown> {
  return {
    seriousness: 'Non-serious',
    meddraPt: 'Headache',
    meddraCode: '10019211',
    soc: 'Nervous system disorders',
    causality: 'possible',
    causalityMethod: 'WHO-UMC',
    expectedness: 'Unexpected',
    regulatoryRequired: 'No',
    regulatoryTimeline: 'Not required',
    authorities: [],
    narrative: 'Synthetic narrative long enough to pass the minimum length check.',
    confidence: {
      seriousness: 'medium',
      meddraPt: 'high',
      soc: 'medium',
      causality: 'medium',
      expectedness: 'low',
      regulatoryRequired: 'medium',
      regulatoryTimeline: 'high',
    },
    rationale: {
      seriousness: 'No serious criterion was described in this synthetic fixture.',
      meddraPt: 'Coded from the fictional verbatim term for the eval harness only.',
      soc: 'System organ class chosen to match the fictional term.',
      causality: 'Possible only because this is a synthetic temporal association.',
      expectedness: 'No reference safety information was supplied with this fixture.',
      regulatoryRequired: 'Non-serious synthetic case would not be expedited.',
      regulatoryTimeline: 'No expedited clock applies to this synthetic fixture.',
    },
    references: [{ citation: 'ICH E2D (synthetic)', relevance: 'Eval fixture only' }],
    ...over,
  };
}

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

async function scoreFixtures() {
  process.env.LLM_PROVIDER = 'mock';
  for (const fixture of FIXTURES) {
    let draft;
    try {
      draft = await assessCase(fixture.text);
    } catch (err) {
      const detail = err instanceof AssessmentError ? err.detail : String(err);
      check(`schema ${fixture.id}`, false, detail);
      check(`enums ${fixture.id}`, false, 'no draft');
      continue;
    }
    check(`schema ${fixture.id}`, draft.promptVersion === PROMPT_VERSION && draft.modelVersion === 'mock-dev-0', draft.modelVersion);
    const mismatches: string[] = ENUM_FIELDS.filter((key) => draft[key] !== fixture.expect[key]);
    if (draft.confidence.seriousness !== fixture.expect.confidenceSeriousness) mismatches.push('confidence.seriousness');
    if (draft.confidence.meddraPt !== fixture.expect.confidenceMeddra) mismatches.push('confidence.meddraPt');
    const matched = ENUM_FIELDS.length + 2 - mismatches.length;
    check(`enums ${fixture.id}`, mismatches.length === 0, `${matched}/${ENUM_FIELDS.length + 2}${mismatches.length ? ' missed ' + mismatches.join(', ') : ''}`);
  }
}

function scoreRejections() {
  for (const sample of INVALID_DRAFTS) {
    let rejected = false;
    try {
      validateDraft(sample.draft, 'eval-invalid');
    } catch (err) {
      rejected = err instanceof DraftValidationError && err.issues.length > 0;
    }
    check(`reject ${sample.id}`, rejected);
  }
}

function scoreProviderSelection() {
  const mockByDefault = resolveLlmConfig({});
  check('unset env selects mock', mockByDefault.provider === 'mock' && mockByDefault.model === 'mock-dev-0');

  const anthropic = resolveLlmConfig({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_MODEL: 'claude-sonnet-5' });
  check(
    'ANTHROPIC_API_KEY alone selects anthropic',
    anthropic.provider === 'anthropic' && anthropic.model === 'claude-sonnet-5' && anthropic.apiKey === 'sk-test',
  );

  const modelOverride = resolveLlmConfig({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_MODEL: 'claude-sonnet-5', LLM_MODEL: 'claude-haiku-5-5' });
  check('LLM_MODEL overrides ANTHROPIC_MODEL', modelOverride.model === 'claude-haiku-5-5');

  const forcedMock = resolveLlmConfig({ LLM_PROVIDER: 'mock', ANTHROPIC_API_KEY: 'sk-test' });
  check('LLM_PROVIDER=mock ignores Anthropic key', forcedMock.provider === 'mock');

  const local = resolveLlmConfig({
    LLM_PROVIDER: 'openai-compatible',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1/',
    LLM_MODEL: 'qwen2.5:1.5b',
    LLM_API_KEY: 'local',
  });
  check(
    'openai-compatible reads base URL, model, key',
    local.provider === 'openai-compatible' &&
      local.baseUrl === 'http://127.0.0.1:11434/v1' &&
      local.model === 'qwen2.5:1.5b' &&
      local.apiKey === 'local',
  );

  let missingUrl = false;
  try {
    resolveLlmConfig({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'x' });
  } catch (err) {
    missingUrl = err instanceof AssessmentError && err.kind === 'provider';
  }
  check('openai-compatible without LLM_BASE_URL is rejected', missingUrl);

  let anthropicKeyOnlyViaLlm = false;
  try {
    const cfg = resolveLlmConfig({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-llm', LLM_MODEL: 'claude-sonnet-5' });
    anthropicKeyOnlyViaLlm = cfg.provider === 'anthropic' && cfg.apiKey === 'sk-llm' && cfg.model === 'claude-sonnet-5';
  } catch {
    anthropicKeyOnlyViaLlm = false;
  }
  check('anthropic accepts LLM_API_KEY when ANTHROPIC_API_KEY is unset', anthropicKeyOnlyViaLlm);
}

async function main() {
  await scoreFixtures();
  scoreRejections();
  scoreProviderSelection();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
