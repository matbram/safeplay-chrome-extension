import { ProfanityWord, SeverityLevel } from '../types';

// Comprehensive profanity list with severity levels
// Severity: mild (common/casual), moderate (offensive), severe (highly offensive), religious (religious terms)

export const PROFANITY_LIST: ProfanityWord[] = [
  // Religious - opt-in category for religious terms some users may want filtered
  { word: 'jesus', severity: 'religious' },
  { word: 'jesus christ', severity: 'religious' },
  { word: 'christ', severity: 'religious' },
  { word: 'god', severity: 'religious' },
  { word: 'oh my god', severity: 'religious' },
  { word: 'omg', severity: 'religious' },
  { word: 'oh god', severity: 'religious' },
  { word: 'my god', severity: 'religious' },
  { word: 'for gods sake', severity: 'religious' },
  { word: 'for god\'s sake', severity: 'religious' },
  { word: 'lord', severity: 'religious' },
  { word: 'oh lord', severity: 'religious' },
  { word: 'dear lord', severity: 'religious' },
  { word: 'good lord', severity: 'religious' },
  { word: 'holy', severity: 'religious' },
  { word: 'holy shit', severity: 'religious' },
  { word: 'holy crap', severity: 'religious' },
  { word: 'holy hell', severity: 'religious' },
  { word: 'holy fuck', severity: 'religious' },
  { word: 'holy cow', severity: 'religious' },
  { word: 'holy smokes', severity: 'religious' },

  // Severe
  { word: 'fuck', severity: 'severe' },
  { word: 'fucking', severity: 'severe' },
  { word: 'fucked', severity: 'severe' },
  { word: 'fucker', severity: 'severe' },
  { word: 'fuckers', severity: 'severe' },
  { word: 'fucks', severity: 'severe' },
  { word: 'motherfucker', severity: 'severe' },
  { word: 'motherfucking', severity: 'severe' },
  { word: 'motherfuckers', severity: 'severe' },
  { word: 'cunt', severity: 'severe' },
  { word: 'cunts', severity: 'severe' },
  { word: 'nigger', severity: 'severe' },
  { word: 'niggers', severity: 'severe' },
  { word: 'nigga', severity: 'severe' },
  { word: 'niggas', severity: 'severe' },
  { word: 'faggot', severity: 'severe' },
  { word: 'faggots', severity: 'severe' },
  { word: 'fag', severity: 'severe' },
  { word: 'fags', severity: 'severe' },
  { word: 'retard', severity: 'severe' },
  { word: 'retarded', severity: 'severe' },
  { word: 'retards', severity: 'severe' },

  // Moderate
  { word: 'shit', severity: 'moderate' },
  { word: 'shits', severity: 'moderate' },
  { word: 'shitty', severity: 'moderate' },
  { word: 'bullshit', severity: 'moderate' },
  { word: 'horseshit', severity: 'moderate' },
  { word: 'shithead', severity: 'moderate' },
  { word: 'shitheads', severity: 'moderate' },
  { word: 'ass', severity: 'moderate' },
  { word: 'asses', severity: 'moderate' },
  { word: 'asshole', severity: 'moderate' },
  { word: 'assholes', severity: 'moderate' },
  { word: 'bastard', severity: 'moderate' },
  { word: 'bastards', severity: 'moderate' },
  { word: 'bitch', severity: 'moderate' },
  { word: 'bitches', severity: 'moderate' },
  { word: 'bitchy', severity: 'moderate' },
  { word: 'cock', severity: 'moderate' },
  { word: 'cocks', severity: 'moderate' },
  { word: 'cocksucker', severity: 'moderate' },
  { word: 'cocksuckers', severity: 'moderate' },
  { word: 'dick', severity: 'moderate' },
  { word: 'dicks', severity: 'moderate' },
  { word: 'dickhead', severity: 'moderate' },
  { word: 'dickheads', severity: 'moderate' },
  { word: 'pussy', severity: 'moderate' },
  { word: 'pussies', severity: 'moderate' },
  { word: 'prick', severity: 'moderate' },
  { word: 'pricks', severity: 'moderate' },
  { word: 'slut', severity: 'moderate' },
  { word: 'sluts', severity: 'moderate' },
  { word: 'slutty', severity: 'moderate' },
  { word: 'whore', severity: 'moderate' },
  { word: 'whores', severity: 'moderate' },
  { word: 'twat', severity: 'moderate' },
  { word: 'twats', severity: 'moderate' },
  { word: 'wanker', severity: 'moderate' },
  { word: 'wankers', severity: 'moderate' },
  { word: 'bollocks', severity: 'moderate' },

  // Mild
  { word: 'damn', severity: 'mild' },
  { word: 'damned', severity: 'mild' },
  { word: 'dammit', severity: 'mild' },
  { word: 'goddamn', severity: 'mild' },
  { word: 'goddamnit', severity: 'mild' },
  { word: 'hell', severity: 'mild' },
  { word: 'crap', severity: 'mild' },
  { word: 'crappy', severity: 'mild' },
  { word: 'piss', severity: 'mild' },
  { word: 'pissed', severity: 'mild' },
  { word: 'pissing', severity: 'mild' },
  { word: 'suck', severity: 'mild' },
  { word: 'sucks', severity: 'mild' },
  { word: 'sucked', severity: 'mild' },
  { word: 'balls', severity: 'mild' },
  { word: 'butt', severity: 'mild' },
  { word: 'butthole', severity: 'mild' },
  { word: 'screw', severity: 'mild' },
  { word: 'screwed', severity: 'mild' },
  { word: 'douche', severity: 'mild' },
  { word: 'douchebag', severity: 'mild' },
  { word: 'douchebags', severity: 'mild' },
];

// Create a Map for O(1) lookup
export const PROFANITY_MAP: Map<string, SeverityLevel> = new Map(
  PROFANITY_LIST.map((item) => [item.word.toLowerCase(), item.severity])
);

// Safe words that contain profanity substrings but are NOT profane
// This prevents false positives like "class" (contains "ass"), "hello" (contains "hell")
export const SAFE_WORDS: Set<string> = new Set([
  // Words containing "ass"
  'class', 'classes', 'classic', 'classical', 'classics', 'classify', 'classified',
  'classification', 'classmate', 'classmates', 'classroom', 'classrooms', 'classy',
  'grass', 'grassy', 'grassland', 'grasshopper',
  'pass', 'passed', 'passes', 'passing', 'passable', 'passage', 'passages',
  'passenger', 'passengers', 'passport', 'passports', 'password', 'passwords',
  'bypass', 'bypassed', 'bypasses', 'bypassing',
  'compass', 'compasses',
  'bass', 'bassist', 'bassline',
  'mass', 'masses', 'massive', 'massively', 'massacre',
  'brass', 'brassy',
  'glass', 'glasses', 'glassy', 'glassware',
  'sass', 'sassy', 'sassafras',
  'lass', 'lassie', 'lasso',
  'cassette', 'cassettes', 'casserole',
  'assassin', 'assassins', 'assassinate', 'assassination',
  'embassy', 'embassies', 'ambassador', 'ambassadors',
  'harass', 'harassed', 'harassing', 'harassment',
  'amass', 'amassed', 'amassing',
  'morass',
  'trespass', 'trespassed', 'trespassing', 'trespasser',
  'carcass', 'carcasses',
  'canvas', 'canvases', 'canvass', 'canvassed',
  'molasses',
  'assume', 'assumed', 'assumes', 'assuming', 'assumption', 'assumptions',
  'assure', 'assured', 'assures', 'assuring', 'assurance',
  'assess', 'assessed', 'assesses', 'assessing', 'assessment', 'assessments',
  'asset', 'assets',
  'assign', 'assigned', 'assigns', 'assigning', 'assignment', 'assignments',
  'assist', 'assisted', 'assists', 'assisting', 'assistant', 'assistants', 'assistance',
  'associate', 'associated', 'associates', 'associating', 'association', 'associations',
  'assort', 'assorted', 'assortment',

  // Words containing "hell"
  'hello', 'hellos',
  'shell', 'shells', 'shelled', 'shelling', 'shellfish', 'bombshell',
  'nutshell', 'eggshell', 'seashell', 'clamshell',
  'dwell', 'dwells', 'dwelled', 'dwelling', 'dwellings',
  'swell', 'swells', 'swelled', 'swelling', 'swollen',
  'well', 'wells', 'wellness', 'farewell', 'stairwell',
  'spell', 'spells', 'spelled', 'spelling', 'misspell', 'misspelled',
  'smell', 'smells', 'smelled', 'smelling', 'smelly',
  'bell', 'bells', 'doorbell', 'bellhop', 'bluebell', 'dumbbell', 'barbell',
  'cell', 'cells', 'cellular', 'cellar', 'cellars',
  'fell', 'fella', 'fellas', 'fellow', 'fellows', 'fellowship',
  'jell', 'jelly', 'jellyfish',
  'tell', 'tells', 'telling', 'teller', 'storytelling', 'foretell',
  'sell', 'sells', 'selling', 'seller', 'sellers', 'bestseller', 'bestselling',
  'yell', 'yells', 'yelled', 'yelling',
  'propel', 'propelled', 'propeller', 'propelling',
  'excel', 'excels', 'excelled', 'excelling', 'excellent', 'excellence',
  'expel', 'expels', 'expelled', 'expelling',
  'compel', 'compels', 'compelled', 'compelling',
  'repel', 'repels', 'repelled', 'repelling', 'repellent',
  'rebellion', 'rebellious', 'rebel', 'rebels', 'rebelled',
  'hellenic', 'hellenistic',

  // Words containing "damn"
  'goddamn', // This IS profanity, but "adam" is not
  'amsterdam',
  'macadam', 'madame', 'madam',

  // Words containing "cock"
  'peacock', 'peacocks',
  'cockpit', 'cockpits',
  'cocktail', 'cocktails',
  'cockatoo', 'cockatoos',
  'cockerel',
  'hancock', 'hitchcock', 'babcock', 'woodcock',
  'stopcock', 'weathercock',

  // Words containing "dick"
  'dickens',
  'benedict', 'benediction',
  'predict', 'predicts', 'predicted', 'predicting', 'prediction', 'predictions',
  'addict', 'addicts', 'addicted', 'addicting', 'addiction', 'addictions', 'addictive',
  'verdict', 'verdicts',
  'indict', 'indicts', 'indicted', 'indicting', 'indictment',
  'contradict', 'contradicts', 'contradicted', 'contradicting', 'contradiction',
  'dictionary', 'dictionaries', 'diction',
  'dictate', 'dictates', 'dictated', 'dictating', 'dictation', 'dictator',
  'edict', 'edicts',
  'jurisdiction',

  // Words containing "crap"
  'scrap', 'scraps', 'scrapped', 'scrapping', 'scrappy', 'scrapbook', 'scrapyard',

  // Words containing "piss"
  'mississippi',

  // Words containing "tit"
  'title', 'titles', 'titled', 'titling', 'subtitle', 'subtitles', 'subtitled',
  'entitle', 'entitled', 'entitles', 'entitling', 'entitlement',
  'constitution', 'constitutional', 'constitutions',
  'institution', 'institutional', 'institutions',
  'restitution',
  'stitute', 'substitute', 'substitutes', 'substituted', 'substitution',
  'institute', 'institutes', 'instituted', 'institution',
  'prostitute', 'prostitutes', 'prostitution', // This might be context-dependent
  'titan', 'titans', 'titanic',
  'appetite', 'appetites', 'appetizer', 'appetizers',
  'competition', 'competitions', 'competitive', 'competitor', 'competitors',
  'petition', 'petitions', 'petitioned', 'petitioning',
  'repetition', 'repetitions', 'repetitive',
  'partition', 'partitions', 'partitioned',
  'quantity', 'quantities', 'quantitative',
  'identity', 'identities',
  'entity', 'entities',
  'utility', 'utilities',
  'fertility', 'infertility',

  // Words containing "cum"
  'document', 'documents', 'documented', 'documenting', 'documentation', 'documentary',
  'circumstance', 'circumstances', 'circumstantial',
  'circumference',
  'accumulate', 'accumulated', 'accumulates', 'accumulating', 'accumulation',
  'cucumber', 'cucumbers',
  'incumbent',
  'succumb', 'succumbed', 'succumbing',

  // Words containing "fag"
  'faggot', // This IS profanity - keeping for reference

  // Words containing "sex" - often legitimate
  'sextant', 'sextet', 'sextuple',

  // Words containing "ho" / "hoe"
  'shoe', 'shoes', 'shoed', 'shoeing', 'horseshoe',
  'hoe', 'hoes', 'hoeing', // gardening tool
  'whole', 'wholesome', 'wholesale', 'wholly',
  'honest', 'honestly', 'honesty', 'dishonest',
  'honor', 'honors', 'honored', 'honoring', 'honorable', 'honorary', 'dishonor',
  'hope', 'hopes', 'hoped', 'hoping', 'hopeful', 'hopefully', 'hopeless',
  'home', 'homes', 'homed', 'homing', 'homeless', 'homemade', 'hometown', 'homework',
  'horse', 'horses', 'horseback', 'horsepower',
  'hotel', 'hotels',
  'horizon', 'horizons', 'horizontal',
  'hour', 'hours', 'hourly',
  'house', 'houses', 'housed', 'housing', 'household', 'housewife', 'housekeeper',

  // Words containing "nig"
  'night', 'nights', 'nightly', 'nighttime', 'nightmare', 'nightmares', 'nightclub',
  'tonight', 'overnight', 'midnight', 'goodnight', 'fortnight',
  'knight', 'knights', 'knighthood',
  'ignite', 'ignites', 'ignited', 'igniting', 'ignition',
  'insignificant', 'significance', 'significant', 'significantly',

  // Words containing "nud"
  'nude', 'nudes', 'nudity', // Context-dependent, usually fine in art/medical context

  // Words containing "porn"
  // Most are actually related to pornography, so no safe words here

  // Words containing "anal"
  'analog', 'analogue', 'analogous', 'analogy', 'analogies',
  'analysis', 'analyses', 'analyst', 'analysts', 'analytical', 'analyze', 'analyzed',
  'banal',
  'canal', 'canals',
  'final', 'finals', 'finally', 'finalist', 'finalize', 'finalized',
  'journal', 'journals', 'journalism', 'journalist', 'journalists',
  'national', 'nationally', 'international', 'internationally',
  'personal', 'personally', 'personality', 'personalities',
  'professional', 'professionally', 'professionals',
  'regional', 'regionally',
  'original', 'originally', 'originals',
  'criminal', 'criminally', 'criminals',
  'terminal', 'terminals',
  'cardinal', 'cardinals',
  'signal', 'signals', 'signaled', 'signaling',

  // Words containing "nut"
  'minute', 'minutes', 'minutely',
  'peanut', 'peanuts',
  'coconut', 'coconuts',
  'chestnut', 'chestnuts',
  'walnut', 'walnuts',
  'doughnut', 'doughnuts', 'donut', 'donuts',
  'nutmeg',
  'nutrition', 'nutritious', 'nutritional', 'nutrient', 'nutrients',

  // Words containing "god" (for religious filter)
  'godfather', 'godfathers', 'godmother', 'godmothers', 'godchild', 'godchildren',
  'godson', 'godsons', 'goddaughter', 'goddaughters',
  'godly', 'godliness', 'ungodly',
  'goddess', 'goddesses',
  'godspeed',
  'godsend',

  // Words containing "lord" (for religious filter)
  'landlord', 'landlords', 'landlady',
  'warlord', 'warlords',
  'overlord', 'overlords',
  'lordship',

  // Words containing "holy" (for religious filter)
  'holiday', 'holidays',
  'wholly',

  // Words containing "christ" (for religious filter)
  'christen', 'christened', 'christening',
  'christian', 'christians', 'christianity',
  'christmas', 'christmastime',
  'christopher',

  // Words containing "jesus" (for religious filter)
  // No common safe words

  // Words containing "hell" that are already covered but adding more religious context
  'hellfire', 'hellbound', // These ARE religious references, not safe words
]);

// Spelling variations mapping - normalizes common letter substitutions
// Maps variant characters to their standard letter
const CHAR_SUBSTITUTIONS: Record<string, string> = {
  // Common leetspeak / symbol substitutions
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  '$': 's',
  '!': 'i',
  '*': '', // Often used as censoring, remove it
  '#': '', // Often used as censoring, remove it
  '+': 't',
  '(': 'c',
  '<': 'c',
  '|': 'i',
  // Common letter swaps
  'ph': 'f',
  'ck': 'k',
};

// Multi-character substitutions (processed first)
const MULTI_CHAR_SUBSTITUTIONS: [string, string][] = [
  ['ph', 'f'],
  ['ck', 'k'],
  ['kk', 'ck'],
  ['cc', 'ck'],
  ['xx', 'x'],
];

/**
 * Normalize a word by replacing common spelling variations with standard letters.
 * This helps detect words like "f*ck", "sh!t", "a$$", "fvck", etc.
 */
export function normalizeSpelling(text: string): string {
  let normalized = text.toLowerCase();

  // First, apply multi-character substitutions
  for (const [from, to] of MULTI_CHAR_SUBSTITUTIONS) {
    normalized = normalized.split(from).join(to);
  }

  // Then, apply single character substitutions
  let result = '';
  for (const char of normalized) {
    result += CHAR_SUBSTITUTIONS[char] ?? char;
  }

  // Remove repeated characters that might be used to evade (e.g., "fuuuck" -> "fuck")
  // But be careful not to break legitimate double letters
  result = result.replace(/(.)\1{2,}/g, '$1$1'); // Keep max 2 of same char

  return result;
}

// Get all words of a specific severity
export function getWordsBySeverity(severity: SeverityLevel): string[] {
  return PROFANITY_LIST
    .filter((item) => item.severity === severity)
    .map((item) => item.word);
}

// Check if a word is profanity (also checks normalized spelling)
export function isProfanity(word: string): boolean {
  const lower = word.toLowerCase();
  if (PROFANITY_MAP.has(lower)) return true;

  // Also check normalized version for spelling variations
  const normalized = normalizeSpelling(lower);
  return PROFANITY_MAP.has(normalized);
}

// Get the severity of a word (also checks normalized spelling)
export function getSeverity(word: string): SeverityLevel | null {
  const lower = word.toLowerCase();
  const direct = PROFANITY_MAP.get(lower);
  if (direct) return direct;

  // Also check normalized version for spelling variations
  const normalized = normalizeSpelling(lower);
  return PROFANITY_MAP.get(normalized) || null;
}

// Check if a word is in the safe list (not profane despite containing profanity substring)
export function isSafeWord(word: string): boolean {
  return SAFE_WORDS.has(word.toLowerCase());
}

// Find profanity within a longer word (e.g., "fuck" in "motherfucker")
// Now checks against safe words to avoid false positives
// Also checks normalized spellings (f*ck, sh!t, etc.)
export function findEmbeddedProfanity(
  text: string
): { word: string; severity: SeverityLevel; startIndex: number; endIndex: number }[] {
  const lowerText = text.toLowerCase().trim();

  // First, check if the entire text is a safe word - if so, return no matches
  if (SAFE_WORDS.has(lowerText)) {
    return [];
  }

  const results: {
    word: string;
    severity: SeverityLevel;
    startIndex: number;
    endIndex: number;
  }[] = [];

  // Check both original and normalized text
  const normalizedText = normalizeSpelling(lowerText);
  const textsToCheck = [lowerText];
  if (normalizedText !== lowerText) {
    textsToCheck.push(normalizedText);
  }

  for (const textToCheck of textsToCheck) {
    for (const [word, severity] of PROFANITY_MAP) {
      let index = textToCheck.indexOf(word);
      while (index !== -1) {
        // Check if the found substring is actually the whole word (exact match)
        // or if it's embedded in a safe context
        const isExactMatch = textToCheck === word;
        const isWholeWord = (index === 0 || !/[a-z]/.test(textToCheck[index - 1])) &&
                            (index + word.length === textToCheck.length || !/[a-z]/.test(textToCheck[index + word.length]));

        // Only add if it's an exact match or a whole word within the text
        // This prevents "ass" matching in "class" but allows "ass" in "bad-ass"
        if (isExactMatch || isWholeWord) {
          // Use original text indices for timing (approximate for normalized)
          results.push({
            word,
            severity,
            startIndex: index,
            endIndex: index + word.length,
          });
        }

        index = textToCheck.indexOf(word, index + 1);
      }
    }
  }

  // Sort by start index and remove duplicates (prefer longer matches)
  results.sort((a, b) => a.startIndex - b.startIndex);

  // Remove overlapping matches, keeping the longer one
  const filtered: typeof results = [];
  for (const match of results) {
    const lastMatch = filtered[filtered.length - 1];
    if (!lastMatch || match.startIndex >= lastMatch.endIndex) {
      filtered.push(match);
    } else if (match.endIndex - match.startIndex > lastMatch.endIndex - lastMatch.startIndex) {
      filtered[filtered.length - 1] = match;
    }
  }

  // Deduplicate by word (in case both original and normalized matched)
  const seen = new Set<string>();
  return filtered.filter(match => {
    const key = `${match.word}-${match.startIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
