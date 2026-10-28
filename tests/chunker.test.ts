import { describe, expect, it } from 'vitest';
import {
  computeNormalizedHash,
  diffChunks,
  normalizeContent,
  parseMarkdownChunks,
  type MarkdownChunk,
} from '../src/core/chunker.js';

describe('chunker', () => {
  describe('normalizeContent & computeNormalizedHash', () => {
    it('normalizes CRLF and trailing line whitespace', () => {
      const textCrlf = 'Rule text line 1  \r\nRule text line 2   \r\n';
      const textLf = 'Rule text line 1\nRule text line 2\n\n';
      const differentText = 'Rule text line 1\nRule text line 3\n';

      expect(normalizeContent(textCrlf)).toBe('Rule text line 1\nRule text line 2');
      expect(normalizeContent(textLf)).toBe('Rule text line 1\nRule text line 2');

      const hash1 = computeNormalizedHash(textCrlf);
      const hash2 = computeNormalizedHash(textLf);
      const hash3 = computeNormalizedHash(differentText);

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });

    it('handles empty strings and whitespace-only text', () => {
      expect(normalizeContent('')).toBe('');
      expect(normalizeContent('   \n  \r\n\t  ')).toBe('');
      expect(computeNormalizedHash('')).toBe(
        computeNormalizedHash('   \r\n\n  '),
      );
    });
  });

  describe('parseMarkdownChunks - hierarchical nesting', () => {
    it('parses headers and maintains correct hierarchy and paths', () => {
      const sample = `# Main Section
Intro text here.

## Subsection A
Content for A.

### Sub-sub 1
Deep leaf.

## Subsection B
Content for B.

# Next Main
Final section.
`;
      const chunks = parseMarkdownChunks(sample);
      expect(chunks).toHaveLength(5);

      // Level 1: Main Section
      expect(chunks[0].header).toBe('Main Section');
      expect(chunks[0].level).toBe(1);
      expect(chunks[0].path).toEqual(['Main Section']);
      expect(chunks[0].content).toContain('Intro text here.');

      // Level 2: Subsection A
      expect(chunks[1].header).toBe('Subsection A');
      expect(chunks[1].level).toBe(2);
      expect(chunks[1].path).toEqual(['Main Section', 'Subsection A']);
      expect(chunks[1].content).toContain('Content for A.');

      // Level 3: Sub-sub 1
      expect(chunks[2].header).toBe('Sub-sub 1');
      expect(chunks[2].level).toBe(3);
      expect(chunks[2].path).toEqual(['Main Section', 'Subsection A', 'Sub-sub 1']);
      expect(chunks[2].content).toContain('Deep leaf.');

      // Level 2: Subsection B (pops Sub-sub 1 and Subsection A)
      expect(chunks[3].header).toBe('Subsection B');
      expect(chunks[3].level).toBe(2);
      expect(chunks[3].path).toEqual(['Main Section', 'Subsection B']);
      expect(chunks[3].content).toContain('Content for B.');

      // Level 1: Next Main (pops all)
      expect(chunks[4].header).toBe('Next Main');
      expect(chunks[4].level).toBe(1);
      expect(chunks[4].path).toEqual(['Next Main']);
      expect(chunks[4].content).toContain('Final section.');
    });

    it('handles skipped header levels correctly', () => {
      const sample = `# Top
## Middle
#### Skipped To Four
Content
`;
      const chunks = parseMarkdownChunks(sample);
      expect(chunks).toHaveLength(3);
      expect(chunks[2].header).toBe('Skipped To Four');
      expect(chunks[2].level).toBe(4);
      expect(chunks[2].path).toEqual(['Top', 'Middle', 'Skipped To Four']);
    });
  });

  describe('parseMarkdownChunks - code fence handling', () => {
    it('ignores # headings inside ``` and ~~~ code fences and captures codeBlocks', () => {
      const sample = `# Code Examples
Here is Python code:

\`\`\`python
# This is a python comment
def add(a, b):
    # Another comment
    return a + b
\`\`\`

And some tilde block:

~~~bash
# Bash comment
echo "hello"
~~~

After code.
`;
      const chunks = parseMarkdownChunks(sample);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].header).toBe('Code Examples');
      expect(chunks[0].codeBlocks).toHaveLength(2);
      expect(chunks[0].codeBlocks[0]).toContain('# This is a python comment');
      expect(chunks[0].codeBlocks[1]).toContain('# Bash comment');
    });

    it('handles nested backticks with 4 backtick fence', () => {
      const sample = `# Multi Fence
\`\`\`\`markdown
\`\`\`js
const x = 1;
\`\`\`
# Not a heading
\`\`\`\`
`;
      const chunks = parseMarkdownChunks(sample);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].header).toBe('Multi Fence');
      expect(chunks[0].codeBlocks).toHaveLength(1);
      expect(chunks[0].codeBlocks[0]).toContain('# Not a heading');
    });

    it('does not treat single-line inline code starting with 3 backticks as a code fence', () => {
      const sample = `# Section
\`\`\`foo\`\`\` inline code span
## Next Section
Content here.
`;
      const chunks = parseMarkdownChunks(sample);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].header).toBe('Section');
      expect(chunks[1].header).toBe('Next Section');
    });
  });

  describe('parseMarkdownChunks - ATX closure & title edge cases', () => {
    it('strips trailing adorned hashes but preserves titles like C#', () => {
      const sample = `## C#
Guidelines for C# development.

## Header With Closing Hashes ###
Content here.

### C# in Depth ####
More C# content.

# Title With # In Middle
Middle hash content.
`;
      const chunks = parseMarkdownChunks(sample);
      expect(chunks).toHaveLength(4);
      expect(chunks[0].header).toBe('C#');
      expect(chunks[1].header).toBe('Header With Closing Hashes');
      expect(chunks[2].header).toBe('C# in Depth');
      expect(chunks[3].header).toBe('Title With # In Middle');
    });
  });

  describe('parseMarkdownChunks - prelude handling', () => {
    it('discards prelude when it only contains HTML comments', () => {
      const withGuard = `<!-- AUTOGENERATED BY AGENTHUB - DO NOT EDIT DIRECTLY. EDIT IN ~/.agenthub/ -->

# Heading
Content
`;
      const chunks = parseMarkdownChunks(withGuard);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].header).toBe('Heading');
      expect(chunks[0].level).toBe(1);
    });

    it('preserves non-comment prelude as level 0 chunk', () => {
      const withPrelude = `<!-- Header comment -->
Preamble note before rules.

# Heading
Content
`;
      const chunks = parseMarkdownChunks(withPrelude);
      expect(chunks).toHaveLength(2);

      const prelude = chunks[0];
      expect(prelude.level).toBe(0);
      expect(prelude.header).toBe('');
      expect(prelude.path).toEqual([]);
      expect(prelude.content).toBe('Preamble note before rules.');
      expect(prelude.raw).toBe('Preamble note before rules.\n');

      expect(chunks[1].header).toBe('Heading');
      expect(chunks[1].level).toBe(1);
    });

    it('returns level 0 chunk for markdown with no headings', () => {
      const text = 'Just plain text.\nSecond line.';
      const chunks = parseMarkdownChunks(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].level).toBe(0);
      expect(chunks[0].header).toBe('');
      expect(chunks[0].path).toEqual([]);
      expect(chunks[0].content).toBe('Just plain text.\nSecond line.');
    });

    it('returns empty array for empty or comment-only markdown', () => {
      expect(parseMarkdownChunks('')).toEqual([]);
      expect(parseMarkdownChunks('   \n\n  ')).toEqual([]);
      expect(parseMarkdownChunks('<!-- Only comments -->\n<!-- Another comment -->')).toEqual([]);
    });
  });

  describe('diffChunks', () => {
    it('classifies identical, modified, added, and removed chunks', () => {
      const sourceText = `# Rule A
Content A.

# Rule B
Content B modified.

# Rule C
Content C (new).
`;
      const targetText = `# Rule A
Content A.

# Rule B
Content B original.

# Rule D
Content D (old).
`;
      const sourceChunks = parseMarkdownChunks(sourceText);
      const targetChunks = parseMarkdownChunks(targetText);

      const diff = diffChunks(sourceChunks, targetChunks);

      // Identical: Rule A
      expect(diff.identical).toHaveLength(1);
      expect(diff.identical[0].header).toBe('Rule A');

      // Modified: Rule B
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].source.header).toBe('Rule B');
      expect(diff.modified[0].target.header).toBe('Rule B');

      // Added: Rule C (in source, not in target)
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0].header).toBe('Rule C');

      // Removed: Rule D (in target, not in source)
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0].header).toBe('Rule D');
    });

    it('correctly handles prelude in diffChunks', () => {
      const sourceWithPrelude = `Prelude text modified.

# Header
Same content.
`;
      const targetWithPrelude = `Prelude text original.

# Header
Same content.
`;
      const sourceChunks = parseMarkdownChunks(sourceWithPrelude);
      const targetChunks = parseMarkdownChunks(targetWithPrelude);

      const diff = diffChunks(sourceChunks, targetChunks);

      expect(diff.identical).toHaveLength(1);
      expect(diff.identical[0].header).toBe('Header');

      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].source.level).toBe(0);
      expect(diff.modified[0].target.level).toBe(0);
    });
  });
});
