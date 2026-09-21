/**
 * Bruno allows `//` line comments inside a JSON body so that requests stay
 * documentable. They are kept in the .bru file but must never reach the wire,
 * so the body is cleaned right before it is handed to the request pipeline.
 *
 * A `//` is only a comment when it is outside a string literal: sequences such
 * as `"url": "http://example.com"` or an escaped `\/\/` stay untouched.
 * Everything from the `//` up to (but not including) the end of the line is
 * dropped, so line numbers reported by JSON parsers stay meaningful.
 */
const stripJsonComments = (input: string): string => {
  if (!input || input.indexOf('//') === -1) {
    return input;
  }

  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') {
        i++;
      }
      i--; // let the loop re-read the line break so it is preserved
      continue;
    }

    result += char;
  }

  return result;
};

export { stripJsonComments };
export default stripJsonComments;
