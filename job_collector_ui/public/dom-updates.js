// Patch in place: unchanged text, focused controls and scrollable containers stay alive.
function key(node) {
  if (node.nodeType !== 1) return '';
  return node.id || (node.dataset.labelJob ? `label:${node.dataset.labelJob}` : node.dataset.task ? `task:${node.dataset.task}` : node.dataset.reviewRow ? `review:${node.dataset.reviewRow}` : '');
}

function patchNode(current, desired) {
  if (current.nodeType !== desired.nodeType || current.nodeName !== desired.nodeName) {
    const replacement = desired.cloneNode(true); current.replaceWith(replacement); return replacement;
  }
  if (current.nodeType !== 1) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return current;
  }
  for (const attr of [...current.attributes]) if (!desired.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  for (const attr of [...desired.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  // Live log and review content are owned by their own API requests, not metadata rendering.
  if (['labelLog', 'labelReview', 'taskLog'].includes(current.id)) return current;
  patchChildren(current, desired);
  return current;
}

function patchChildren(current, desired) {
  let cursor = current.firstChild;
  for (const wanted of [...desired.childNodes]) {
    const wantedKey = key(wanted);
    const match = wantedKey ? [...current.childNodes].find(child => key(child) === wantedKey) : cursor && !key(cursor) ? cursor : null;
    let patched;
    if (!match) {
      patched = wanted.cloneNode(true); current.insertBefore(patched, cursor);
    } else {
      if (match !== cursor) current.insertBefore(match, cursor);
      patched = patchNode(match, wanted);
    }
    cursor = patched.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

export function patchHtml(element, html) {
  const template = document.createElement('template'); template.innerHTML = html;
  patchChildren(element, template.content);
}

export function updateLog(element, content) {
  if (element.textContent === content) return;
  const top = element.scrollTop;
  const following = element.scrollHeight - top - element.clientHeight < 60;
  const previous = element.textContent;
  if (previous && content.startsWith(previous)) element.append(document.createTextNode(content.slice(previous.length)));
  else element.textContent = content;
  element.scrollTop = following ? element.scrollHeight : top;
}
