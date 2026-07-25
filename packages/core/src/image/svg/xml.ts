/**
 * A very small XML reader, for the SVG subset only.
 *
 * There is no DOM in `@demake/core` (doc 02 §platform purity) and adding a
 * parser dependency would put a third party between a source asset and the
 * bytes in a ROM. What is needed is narrow — elements, attributes, nesting,
 * comments — so it is written here, where its behaviour on malformed input is
 * a typed error rather than a surprise.
 *
 * Deliberately absent: DTDs, entities beyond the five predefined ones,
 * processing instructions with content, namespaces as anything but part of a
 * name. An SVG that needs those is not the kind of file a sprite is drawn in,
 * and pretending otherwise would mean quietly mis-rendering it.
 */

import { DemakeError } from "../../errors.js";

/** One element: its tag, attributes and children, in document order. */
export interface XmlNode {
  tag: string;
  attrs: Readonly<Record<string, string>>;
  children: XmlNode[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Expand the five predefined entities and numeric character references. */
function unescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const ATTR = /\s*([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

/** Parse a document and return its root element. */
export function parseXml(text: string): XmlNode {
  let at = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  const fail = (message: string): never => {
    const line = text.slice(0, at).split("\n").length;
    throw new DemakeError("E_BAD_INPUT", `${message} (line ${line})`, {
      hint: "the SVG reader accepts elements, attributes and comments; check the file is well formed",
    });
  };

  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open < 0) break;
    at = open + 1;

    if (text.startsWith("!--", at)) {
      const end = text.indexOf("-->", at);
      at = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("?", at) || text.startsWith("!", at)) {
      // `<?xml …?>` and `<!DOCTYPE …>`: skipped whole, never interpreted.
      const end = text.indexOf(">", at);
      at = end < 0 ? text.length : end + 1;
      continue;
    }

    const closing = text.startsWith("/", at);
    if (closing) at += 1;

    NAME.lastIndex = at;
    const name = NAME.exec(text);
    if (!name) fail("expected an element name after '<'");
    const tag = (name as RegExpExecArray)[0];
    at = NAME.lastIndex;

    if (closing) {
      const end = text.indexOf(">", at);
      if (end < 0) fail(`unterminated closing tag </${tag}`);
      at = end + 1;
      const top = stack.pop();
      if (!top) fail(`</${tag}> closes nothing`);
      if ((top as XmlNode).tag !== tag) fail(`</${tag}> closes <${(top as XmlNode).tag}>`);
      continue;
    }

    const attrs: Record<string, string> = {};
    for (;;) {
      ATTR.lastIndex = at;
      const attr = ATTR.exec(text);
      if (!attr) break;
      attrs[attr[1] as string] = unescape((attr[3] ?? attr[4] ?? "") as string);
      at = ATTR.lastIndex;
    }

    while (at < text.length && /\s/.test(text[at] as string)) at += 1;
    const selfClosing = text.startsWith("/>", at);
    if (!selfClosing && !text.startsWith(">", at)) fail(`malformed attributes in <${tag}>`);
    at += selfClosing ? 2 : 1;

    const node: XmlNode = { tag, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root) fail("a document has one root element");
    else root = node;
    if (!selfClosing) stack.push(node);
  }

  if (stack.length > 0) {
    throw new DemakeError("E_BAD_INPUT", `<${(stack[0] as XmlNode).tag}> is never closed`);
  }
  if (!root) throw new DemakeError("E_BAD_INPUT", "the document has no elements");
  return root;
}
