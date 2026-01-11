import { ProfanityWord, SeverityLevel } from '../types';

// Comprehensive profanity list with severity levels
// Severity: mild (common/casual), moderate (offensive), severe (highly offensive)

export const PROFANITY_LIST: ProfanityWord[] = [
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

// Get all words of a specific severity
export function getWordsBySeverity(severity: SeverityLevel): string[] {
  return PROFANITY_LIST
    .filter((item) => item.severity === severity)
    .map((item) => item.word);
}

// Check if a word is profanity
export function isProfanity(word: string): boolean {
  return PROFANITY_MAP.has(word.toLowerCase());
}

// Get the severity of a word
export function getSeverity(word: string): SeverityLevel | null {
  return PROFANITY_MAP.get(word.toLowerCase()) || null;
}

// Find profanity within a longer word (e.g., "fuck" in "motherfucker")
export function findEmbeddedProfanity(
  text: string
): { word: string; severity: SeverityLevel; startIndex: number; endIndex: number }[] {
  const results: {
    word: string;
    severity: SeverityLevel;
    startIndex: number;
    endIndex: number;
  }[] = [];
  const lowerText = text.toLowerCase();

  for (const [word, severity] of PROFANITY_MAP) {
    let index = lowerText.indexOf(word);
    while (index !== -1) {
      results.push({
        word,
        severity,
        startIndex: index,
        endIndex: index + word.length,
      });
      index = lowerText.indexOf(word, index + 1);
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

  return filtered;
}
