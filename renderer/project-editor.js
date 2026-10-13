import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import { jsonDefaults } from 'monaco-editor/language/json/monaco.contribution.js';
import { parseDocument } from 'yaml';

// Workers are emitted beside app.js. No CDN, remote language service or schema
// downloads are used by the editor.
globalThis.MonacoEnvironment = {
  getWorker(_id, label) {
    return new Worker(new URL(`./dist/${label === 'json' ? 'json' : 'editor'}.worker.js`, document.baseURI), { type: 'module' });
  }
};
jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: false, enableSchemaRequest: false, schemas: [] });

const snippets = [
  ['playbook', 'Ansible playbook', '---\n- name: ${1:Describe this play}\n  hosts: ${2:all}\n  gather_facts: false\n  tasks:\n    - name: ${3:Describe the task}\n      ansible.builtin.debug:\n        msg: "${4:Hello from ForgeCRT}"\n'],
  ['task', 'Named Ansible task', '- name: ${1:Describe the task}\n  ansible.builtin.${2:debug}:\n    ${3:msg}: ${4:value}\n'],
  ['template', 'Render a Jinja template', '- name: ${1:Render configuration}\n  ansible.builtin.template:\n    src: ${2:templates/config.j2}\n    dest: ${3:/etc/example.conf}\n    mode: "0644"\n'],
  ['copy', 'Copy a file with an explicit mode', '- name: ${1:Copy configuration}\n  ansible.builtin.copy:\n    src: ${2:files/config.conf}\n    dest: ${3:/etc/example.conf}\n    mode: "0644"\n'],
  ['assert', 'Verify a condition', '- name: ${1:Verify precondition}\n  ansible.builtin.assert:\n    that:\n      - ${2:condition}\n    fail_msg: "${3:Precondition was not met}"\n'],
  ['block', 'Task block with rescue', '- name: ${1:Operation}\n  block:\n    - name: ${2:Task}\n      ansible.builtin.debug:\n        msg: "${3:message}"\n  rescue:\n    - name: Report failure\n      ansible.builtin.debug:\n        msg: "Operation failed"\n'],
  ['inventory', 'YAML inventory', 'all:\n  children:\n    ${1:network}:\n      hosts:\n        ${2:router01}:\n          ansible_host: ${3:192.0.2.10}\n']
];
const ansibleKeys = [
  ['name', 'A descriptive name for a play or task.'], ['hosts', 'Inventory pattern targeted by this play.'],
  ['tasks', 'Ordered tasks for this play.'], ['gather_facts', 'Whether to gather facts before tasks.'],
  ['vars', 'Variables defined in this play or task.'], ['vars_files', 'Variable files loaded by this play.'],
  ['roles', 'Roles applied by this play.'], ['handlers', 'Tasks triggered by notifications.'],
  ['when', 'Conditional expression controlling a task.'], ['register', 'Variable receiving a task result.'],
  ['loop', 'Values iterated by a task.'], ['notify', 'Handlers notified when the task changes something.'],
  ['become', 'Whether to use privilege escalation.'], ['become_user', 'Account used for privilege escalation.'],
  ['tags', 'Tags assigned to the play or task.'], ['delegate_to', 'Host on which to execute this task.'],
  ['check_mode', 'Task-specific check-mode override; false may change systems even during a check run.'],
  ['changed_when', 'Expression controlling the changed result.'], ['failed_when', 'Expression controlling task failure.'],
  ['ansible.builtin.debug', 'Print a message or variable.'], ['ansible.builtin.assert', 'Assert that conditions hold.'],
  ['ansible.builtin.copy', 'Copy files to managed hosts.'], ['ansible.builtin.template', 'Render a Jinja template to a managed host.'],
  ['ansible.builtin.file', 'Manage file, directory and symlink attributes.'], ['ansible.builtin.service', 'Manage a service.'],
  ['ansible.builtin.command', 'Execute a command without shell processing.'], ['ansible.builtin.shell', 'Execute through a shell; review quoting and inputs.'],
  ['ansible.builtin.include_tasks', 'Include a task file dynamically.'], ['ansible.builtin.import_tasks', 'Import a task file statically.'],
  ['ansible.builtin.set_fact', 'Set variables for the current host.']
];

monaco.languages.register({ id: 'jinja', extensions: ['.j2', '.jinja', '.jinja2'], aliases: ['Jinja'] });
monaco.languages.register({ id: 'diff', extensions: ['.diff', '.patch'] });
monaco.languages.setMonarchTokensProvider('diff', { tokenizer: { root: [[/^\+.*/, 'string'], [/^-.*/, 'comment'], [/^@@.*/, 'keyword'], [/^diff.*/, 'keyword']] } });
monaco.languages.setLanguageConfiguration('jinja', { comments: { blockComment: ['{#', '#}'] }, brackets: [['{', '}'], ['[', ']'], ['(', ')']], autoClosingPairs: [{ open: '{{', close: '}}' }, { open: '{%', close: '%}' }, { open: '"', close: '"' }] });
monaco.languages.setMonarchTokensProvider('jinja', {
  tokenizer: {
    root: [[/\{#/, 'comment', '@comment'], [/\{[{%]-?/, 'delimiter', '@expression'], [/.+?(?=\{|$)/, 'string'], [/./, 'string']],
    comment: [[/#\}/, 'comment', '@pop'], [/./, 'comment']],
    expression: [[/-?[}%]\}/, 'delimiter', '@pop'], [/\b(?:if|else|elif|endif|for|endfor|in|set|block|endblock|include|extends|macro|endmacro|not|and|or|true|false|none)\b/, 'keyword'], [/"[^"\n]*"|'[^'\n]*'/, 'string'], [/\d+(?:\.\d+)?/, 'number'], [/[A-Za-z_][\w.]*/, 'variable'], [/./, 'delimiter']]
  }
});

monaco.languages.registerCompletionItemProvider('yaml', {
  triggerCharacters: [':', '.'],
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    return { suggestions: [
      ...snippets.map(([label, detail, insertText]) => ({ label, detail, insertText, range, kind: monaco.languages.CompletionItemKind.Snippet, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
      ...ansibleKeys.map(([label, documentation]) => ({ label, documentation, range, kind: monaco.languages.CompletionItemKind.Property, insertText: `${label}: ` }))
    ] };
  }
});
monaco.languages.registerCompletionItemProvider('jinja', {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    return { suggestions: [['variable', '{{ ${1:variable} }}'], ['for', '{% for ${1:item} in ${2:items} %}\n${3:content}\n{% endfor %}'], ['if', '{% if ${1:condition} %}\n${2:content}\n{% endif %}']].map(([label, insertText]) => ({ label, insertText, range, kind: monaco.languages.CompletionItemKind.Snippet, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })) };
  }
});
monaco.languages.registerCompletionItemProvider('python', {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    return { suggestions: [
      ['main', 'def main():\n    ${1:pass}\n\n\nif __name__ == "__main__":\n    main()\n'],
      ['function', 'def ${1:function_name}(${2:arguments}):\n    """${3:Describe this function}."""\n    ${4:pass}\n'],
      ['tryexcept', 'try:\n    ${1:pass}\nexcept ${2:Exception} as error:\n    ${3:raise}\n']
    ].map(([label, insertText]) => ({ label, insertText, range, kind: monaco.languages.CompletionItemKind.Snippet, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })) };
  }
});

export function documentLanguage(path) {
  if (/\.(yml|yaml)$/i.test(path)) return 'yaml';
  if (/\.(j2|jinja|jinja2)$/i.test(path)) return 'jinja';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.(sh|bash|zsh)$/i.test(path)) return 'shell';
  if (/\.(ini|cfg|conf)$/i.test(path)) return 'ini';
  if (/\.md$/i.test(path)) return 'markdown';
  if (/\.(diff|patch)$/i.test(path)) return 'diff';
  return 'plaintext';
}

export function watchYaml(model, changed = () => {}) {
  if (model.getLanguageId() === 'json') {
    const uri = model.uri.toString();
    const markers = monaco.editor.onDidChangeMarkers((resources) => {
      if (model.isDisposed() || !resources.some((resource) => resource.toString() === uri)) return;
      const count = monaco.editor.getModelMarkers({ resource: model.uri }).filter((marker) => marker.severity === monaco.MarkerSeverity.Error || marker.severity === monaco.MarkerSeverity.Warning).length;
      changed(count ? `${count} JSON syntax issue${count === 1 ? '' : 's'}` : 'JSON syntax checked locally');
    });
    const content = model.onDidChangeContent(() => changed('Checking JSON syntax locally…'));
    changed('Checking JSON syntax locally…');
    return { dispose() { markers.dispose(); content.dispose(); } };
  }
  let timer;
  function validate() {
    if (model.isDisposed() || model.getLanguageId() !== 'yaml') return;
    const text = model.getValue();
    // Jinja is resolved by Ansible, not by this local syntax-only parser.
    if (text.length > 262144 || /\{%|\{\{/.test(text)) {
      monaco.editor.setModelMarkers(model, 'termforge-yaml', []);
      changed(text.length > 262144 ? 'YAML diagnostics paused for a large file.' : 'Jinja expressions: YAML syntax diagnostics deferred to Ansible.');
      return;
    }
    const parsed = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false });
    const markers = parsed.errors.slice(0, 100).map((error) => {
      const start = model.getPositionAt(error.pos?.[0] || 0);
      const end = model.getPositionAt(Math.max((error.pos?.[0] || 0) + 1, error.pos?.[1] || 0));
      return { severity: monaco.MarkerSeverity.Error, message: String(error.message), startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
    });
    monaco.editor.setModelMarkers(model, 'termforge-yaml', markers);
    changed(markers.length ? `${markers.length} YAML syntax issue${markers.length === 1 ? '' : 's'}` : 'YAML syntax checked locally');
  }
  const listener = model.onDidChangeContent(() => { clearTimeout(timer); timer = setTimeout(validate, 300); });
  timer = setTimeout(validate, 0);
  return { dispose() { clearTimeout(timer); listener.dispose(); } };
}

export function applyEditorTheme() {
  const style = getComputedStyle(document.documentElement);
  const get = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  let dark = document.documentElement.dataset.theme === 'dark';
  const field = get('--field', dark ? '#1b2b3c' : '#ffffff');
  const hex = field.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const value = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    dark = (parseInt(value.slice(0, 2), 16) * 299 + parseInt(value.slice(2, 4), 16) * 587 + parseInt(value.slice(4, 6), 16) * 114) / 1000 < 128;
  }
  const text = get('--text', dark ? '#e0e8f2' : '#223246');
  monaco.editor.defineTheme('termforge', {
    base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: {
      'editor.background': field, 'editor.foreground': text,
      'editorLineNumber.foreground': get('--muted', '#7b8899'),
      'editorLineNumber.activeForeground': text,
      'editorCursor.foreground': get('--accent', '#087c70'),
      'editor.selectionBackground': get('--select', '#dcefe9'),
      'editor.lineHighlightBackground': get('--panel', field),
      'editorWidget.background': get('--panel', field),
      'editorWidget.border': get('--border', '#d5dee8')
    }
  });
  monaco.editor.setTheme('termforge');
}

export const editorOptions = {
  theme: 'termforge', automaticLayout: true, fontSize: 13,
  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 12, bottom: 12 },
  lineNumbersMinChars: 3, glyphMargin: false, folding: true, tabSize: 2, insertSpaces: true,
  wordWrap: 'off', renderWhitespace: 'selection', stickyScroll: { enabled: false },
  quickSuggestions: { other: true, comments: false, strings: false },
  accessibilitySupport: 'auto', links: false, unicodeHighlight: { ambiguousCharacters: false },
  fixedOverflowWidgets: true, contextmenu: true
};

export { monaco };
