import {
  TranscriptSegment,
  Transcript,
  MuteInterval,
  UserPreferences,
  SeverityLevel,
  ProfanityMatch,
} from '../types';
import {
  PROFANITY_MAP,
  findEmbeddedProfanity,
  isSafeWord,
} from './profanity-list';

export class TranscriptParser {
  private preferences: UserPreferences;
  private customBlacklistMap: Map<string, SeverityLevel>;
  private customWhitelistSet: Set<string>;

  constructor(preferences: UserPreferences) {
    this.preferences = preferences;

    // Build custom blacklist map (all custom words are severe by default)
    this.customBlacklistMap = new Map(
      preferences.customBlacklist.map((word) => [word.toLowerCase(), 'severe' as SeverityLevel])
    );

    // Build whitelist set
    this.customWhitelistSet = new Set(
      preferences.customWhitelist.map((word) => word.toLowerCase())
    );
  }

  // Check if a severity level should be filtered based on preferences
  private shouldFilterSeverity(severity: SeverityLevel): boolean {
    return this.preferences.severityLevels[severity];
  }

  // Check if a word should be filtered (considering whitelist/blacklist)
  private shouldFilterWord(word: string, severity: SeverityLevel): boolean {
    const lowerWord = word.toLowerCase();

    // Check whitelist first (user explicitly allowed)
    if (this.customWhitelistSet.has(lowerWord)) {
      return false;
    }

    // Check custom blacklist (always filter)
    if (this.customBlacklistMap.has(lowerWord)) {
      return true;
    }

    // Check severity level preference
    return this.shouldFilterSeverity(severity);
  }

  // Get severity for a word (checking custom blacklist too)
  private getWordSeverity(word: string): SeverityLevel | null {
    const lowerWord = word.toLowerCase();

    // Check custom blacklist first (takes priority over safe words)
    if (this.customBlacklistMap.has(lowerWord)) {
      return this.customBlacklistMap.get(lowerWord)!;
    }

    // Check if it's a safe word (e.g., "class" contains "ass" but is not profane)
    if (isSafeWord(lowerWord)) {
      return null;
    }

    // Check built-in profanity list
    return PROFANITY_MAP.get(lowerWord) || null;
  }

  // Get word-level timing from segment
  private getWordTiming(
    segment: TranscriptSegment
  ): { startTime: number; endTime: number } {
    return { startTime: segment.start_time, endTime: segment.end_time };
  }

  // Find profanity matches in transcript segments
  findProfanityMatches(segments: TranscriptSegment[]): ProfanityMatch[] {
    const matches: ProfanityMatch[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const normalizedText = segment.text.toLowerCase().trim();

      // Check for exact word match first
      const exactSeverity = this.getWordSeverity(normalizedText);
      if (exactSeverity && this.shouldFilterWord(normalizedText, exactSeverity)) {
        const { startTime, endTime } = this.getWordTiming(segment);

        matches.push({
          segmentIndex: i,
          word: segment.text,
          severity: exactSeverity,
          startTime,
          endTime,
          isPartialMatch: false,
        });
        continue;
      }

      // Check for embedded profanity within longer words
      const embeddedMatches = findEmbeddedProfanity(normalizedText);

      // Also check custom blacklist for embedded matches
      for (const [customWord] of this.customBlacklistMap) {
        const index = normalizedText.indexOf(customWord);
        if (index !== -1) {
          embeddedMatches.push({
            word: customWord,
            severity: 'severe',
            startIndex: index,
            endIndex: index + customWord.length,
          });
        }
      }

      for (const embedded of embeddedMatches) {
        if (!this.shouldFilterWord(embedded.word, embedded.severity)) {
          continue;
        }

        const { startTime, endTime } = this.getWordTiming(segment);

        matches.push({
          segmentIndex: i,
          word: embedded.word,
          severity: embedded.severity,
          startTime,
          endTime,
          isPartialMatch: true,
          matchedPortion: segment.text.substring(embedded.startIndex, embedded.endIndex),
        });
      }
    }

    return matches;
  }

  // Convert profanity matches to mute intervals with padding
  createMuteIntervals(matches: ProfanityMatch[]): MuteInterval[] {
    // Use asymmetric padding if available, otherwise fall back to symmetric
    const paddingBeforeSeconds = (this.preferences.paddingBeforeMs ?? this.preferences.paddingMs) / 1000;
    const paddingAfterSeconds = (this.preferences.paddingAfterMs ?? this.preferences.paddingMs) / 1000;

    return matches.map((match) => {
      const interval = {
        start: Math.max(0, match.startTime - paddingBeforeSeconds),
        end: match.endTime + paddingAfterSeconds,
        word: match.word,
        severity: match.severity,
      };

      console.log(`[SafePlay Parser] Mute interval: "${match.word}" ` +
        `${interval.start.toFixed(3)}s - ${interval.end.toFixed(3)}s ` +
        `(padding: -${paddingBeforeSeconds * 1000}ms / +${paddingAfterSeconds * 1000}ms)`);

      return interval;
    });
  }

  // Merge overlapping or close intervals
  mergeIntervals(intervals: MuteInterval[]): MuteInterval[] {
    if (intervals.length === 0) {
      return [];
    }

    // Sort by start time
    const sorted = [...intervals].sort((a, b) => a.start - b.start);
    const mergeThresholdSeconds = this.preferences.mergeThresholdMs / 1000;

    const merged: MuteInterval[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const last = merged[merged.length - 1];

      // Merge if overlapping or within threshold
      if (current.start <= last.end + mergeThresholdSeconds) {
        // Extend the end time and combine words
        last.end = Math.max(last.end, current.end);
        // Keep the more severe classification
        if (this.severityRank(current.severity) > this.severityRank(last.severity)) {
          last.severity = current.severity;
        }
        // Append word if different
        if (!last.word.includes(current.word)) {
          last.word = `${last.word}, ${current.word}`;
        }
      } else {
        merged.push({ ...current });
      }
    }

    return merged;
  }

  private severityRank(severity: SeverityLevel): number {
    const ranks: Record<SeverityLevel, number> = {
      mild: 1,
      religious: 2,
      moderate: 3,
      severe: 4,
    };
    return ranks[severity];
  }

  // Main parsing function: transcript -> mute intervals
  parse(transcript: Transcript): MuteInterval[] {
    const matches = this.findProfanityMatches(transcript.segments);
    const intervals = this.createMuteIntervals(matches);
    return this.mergeIntervals(intervals);
  }
}

// Utility function for quick parsing
export function parseTranscript(
  transcript: Transcript,
  preferences: UserPreferences
): MuteInterval[] {
  const parser = new TranscriptParser(preferences);
  return parser.parse(transcript);
}
