import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { callLlm, getLLMConfig } from '../services/llm';
import { GlobalState } from '../globalState';
import { applyCompositeFix } from '../utils/vscodeUtils';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    files?: string[];
    fullText?: string;
    editedFiles?: string[];
}

export class AgentChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agentChat.chatView';
    private _view?: vscode.WebviewView;
    private _conversationHistory: ChatMessage[] = [];
    private _systemContext: string = "";

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'sendMessage': await this._handleSendMessage(data.message, data.attachedFiles); break;
                case 'pickFile': await this._handleFilePick(); break;
                case 'executeCommand': vscode.commands.executeCommand(data.command); break;
                case 'resetChat':
                    this._conversationHistory = [];
                    this._systemContext = "";
                    this._view?.webview.postMessage({ type: 'reset' });
                    break;
            }
        });
    }

    public addInteraction(query: string, files: string[], response: string, fullContext: string) {
        if (!this._view) {
            vscode.commands.executeCommand('alloyai.openChat');
            setTimeout(() => this.addInteraction(query, files, response, fullContext), 500);
            return;
        }

        this._systemContext = fullContext;
        this._conversationHistory.push({
            role: 'user',
            content: query,
            files,
            fullText: `CONTEXT:\n${fullContext}\n\nREQUEST: ${query}`
        });
        this._conversationHistory.push({ role: 'assistant', content: response, fullText: response });

        this._view.show?.(true);
        this._view.webview.postMessage({ type: 'addHistory', query: query, files: files, response: response });
    }

    private async _handleFilePick() {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach to Context',
            filters: { 'Code': ['ts', 'js', 'py', 'java', 'html', 'css', 'json', 'cpp', 'c', 'cs'] }
        });
        if (uris && uris.length > 0) {
            this._view?.webview.postMessage({
                type: 'filePicked',
                files: uris.map(u => ({ name: path.basename(u.fsPath), path: u.fsPath }))
            });
        }
    }

    private async _handleSendMessage(message: string, attachedFilePaths: string[] = []) {
        if (!this._view) return;

        this._view.webview.postMessage({ type: 'userMessage', message, files: attachedFilePaths.map(p => path.basename(p)) });
        this._view.webview.postMessage({ type: 'setLoading', value: true });

        // Load file content
        let attachmentContext = "";
        for (const fPath of attachedFilePaths) {
            try {
                const content = await fs.readFile(fPath, 'utf-8');
                attachmentContext += `\n\n--- ATTACHED FILE: ${path.basename(fPath)} ---\n${content}\n`;
            } catch (e) {
                console.error(`Failed to read ${fPath}`, e);
            }
        }

        const fullMessageContent = message + attachmentContext;
        this._conversationHistory.push({
            role: 'user',
            content: message,
            files: attachedFilePaths.map(p => path.basename(p)),
            fullText: fullMessageContent
        });

        try {
            const config = await getLLMConfig();
            if (!config) throw new Error("LLM Configuration missing.");

            let loopCount = 0;
            const MAX_LOOPS = 3;
            let currentFullPrompt = fullMessageContent;
            let finalExplanation = "";
            let editedFilesList: string[] = [];

            while (loopCount < MAX_LOOPS) {
                let historyPrompt = `
                SYSTEM CONTEXT:
                ${this._systemContext} 
                (Note: Attached files in history override system context)

                CONVERSATION HISTORY:
                `;

                this._conversationHistory.forEach((msg, index) => {
                    const text = msg.fullText || msg.content;
                    if (index === this._conversationHistory.length - 1 && msg.role === 'user' && loopCount === 0) return;
                    historyPrompt += `\n${msg.role.toUpperCase()}: ${text}`;
                });

                if (loopCount === 0) {
                    historyPrompt += `\n\nUSER REQUEST: ${currentFullPrompt}`;
                } else {
                    historyPrompt += `\n\nAGENT STEP ${loopCount}: ${currentFullPrompt}`;
                }

                const response = await callLlm(config, historyPrompt, 'agent');

                if (response.searchQuery && GlobalState.indexer) {
                    this._view.webview.postMessage({ type: 'statusUpdate', text: `Searching: ${response.searchQuery}...` });
                    const searchResults = await GlobalState.indexer.findRelevantContext(response.searchQuery);
                    currentFullPrompt = `\nI searched for "${response.searchQuery}".\nSEARCH RESULTS:\n${searchResults.context || "No files found."}\n\nNow, perform the requested action.`;
                    this._conversationHistory.push({ role: 'assistant', content: `Checking codebase for: ${response.searchQuery}`, fullText: `(Agent searched for ${response.searchQuery})` });
                    loopCount++;
                    continue;
                }

                if (response.fixes.length > 0) {
                    this._view.webview.postMessage({ type: 'statusUpdate', text: `Editing ${response.fixes.length} files...` });
                    await applyCompositeFix(response.fixes);
                    response.fixes.forEach(f => editedFilesList.push(path.basename(f.filePath)));
                    finalExplanation = response.explanation || `I have updated ${response.fixes.length} files.`;
                    break;
                }

                finalExplanation = response.explanation;
                break;
            }

            this._conversationHistory.push({ role: 'assistant', content: finalExplanation, fullText: finalExplanation, editedFiles: editedFilesList });
            this._view.webview.postMessage({
                type: 'assistantMessage',
                message: finalExplanation,
                editedFiles: editedFilesList
            });

        } catch (error: any) {
            this._view.webview.postMessage({ type: 'assistantMessage', message: `Error: ${error.message}` });
        } finally {
            this._view.webview.postMessage({ type: 'setLoading', value: false });
            this._view.webview.postMessage({ type: 'statusUpdate', text: '' });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Alloy Chat</title>
    <style>
        :root {
            --zinc-950: #14171d;
            --zinc-925: #171b22;
            --zinc-900: #1b2029;
            --zinc-850: #1f252f;
            --zinc-800: #2a3240;
            --zinc-700: #3a4354;
            --zinc-600: #525e72;
            --zinc-400: #a5afbe;
            --zinc-300: #ccd3df;
            --zinc-100: #eef1f6;
            --line: rgba(255, 255, 255, 0.07);
            --line-strong: rgba(255, 255, 255, 0.14);
            --surface-soft: rgba(255, 255, 255, 0.04);
            --font-family: "Inter", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        }

        * { box-sizing: border-box; }

        body {
            background: linear-gradient(180deg, var(--zinc-925) 0%, var(--zinc-950) 100%);
            color: var(--zinc-300);
            font-family: var(--font-family);
            font-size: 13px;
            line-height: 1.65;
            font-weight: 400;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        .quick-actions {
            display: flex;
            gap: 10px;
            padding: 14px 14px 12px;
            background: var(--zinc-900);
            border-bottom: 1px solid var(--line);
            flex-shrink: 0;
            overflow-x: auto;
        }

        .action-btn {
            background: transparent;
            color: var(--zinc-300);
            border: 1px solid var(--line-strong);
            padding: 7px 12px;
            border-radius: 8px;
            font-size: 11px;
            line-height: 1;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
            letter-spacing: 0.01em;
            transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
        }

        .action-btn:hover {
            background-color: var(--zinc-800);
            border-color: var(--zinc-600);
            color: var(--zinc-100);
        }

        .chat-scroll-area {
            flex: 1;
            overflow-y: auto;
            padding: 16px 16px 4px;
            scroll-behavior: smooth;
            background: var(--zinc-950);
        }

        .chat-list {
            display: flex;
            flex-direction: column;
            gap: 20px;
            padding-bottom: 12px;
        }

        .chat-list.is-empty {
            min-height: 100%;
            justify-content: center;
        }

        .message {
            display: flex;
            flex-direction: column;
            gap: 6px;
            width: 100%;
            animation: slideUpFade 0.22s ease-out;
        }

        @keyframes slideUpFade {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.user {
            align-self: flex-end;
            align-items: flex-end;
        }

        .message.user .meta {
            color: var(--zinc-400);
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }

        .message.user .content {
            max-width: 92%;
            background: var(--surface-soft);
            border: 1px solid var(--line);
            color: var(--zinc-100);
            border-radius: 10px 10px 10px 4px;
            padding: 10px 12px;
            font-size: 13px;
            line-height: 1.7;
            font-weight: 400;
        }

        .message.assistant {
            align-self: flex-start;
            align-items: flex-start;
            padding-right: 10%;
        }

        .message.assistant .meta {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--zinc-400);
        }

        .message.assistant .content {
            background: transparent;
            color: var(--zinc-300);
            padding: 2px 0 0;
            font-size: 13px;
            line-height: 1.75;
        }

        .input-container {
            padding: 12px 14px 14px;
            background: var(--zinc-900);
            border-top: 1px solid var(--line);
            flex-shrink: 0;
        }

        .input-box {
            background: var(--zinc-850);
            border: 1px solid var(--line-strong);
            border-radius: 12px;
            padding: 10px 10px 8px;
            transition: border-color 140ms ease, background 140ms ease;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .input-box:focus-within {
            border-color: var(--zinc-600);
            background: #1d1f24;
        }

        .files-preview {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 2px;
        }

        .file-chip {
            background: rgba(255, 255, 255, 0.04);
            color: var(--zinc-300);
            border: 1px solid var(--line);
            border-radius: 6px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 6px;
            animation: fadeIn 0.2s;
        }

        .remove-file {
            cursor: pointer;
            opacity: 0.7;
            font-weight: bold;
        }
        .remove-file:hover {
            opacity: 1;
            color: var(--zinc-100);
        }

        .input-row {
            display: flex;
            align-items: flex-end;
            gap: 6px;
        }

        textarea {
            flex: 1;
            background: transparent;
            border: none;
            color: var(--zinc-100);
            font-family: inherit;
            font-size: 13px;
            font-weight: 400;
            resize: none;
            outline: none;
            max-height: 200px;
            padding: 6px 2px;
            line-height: 1.65;
        }

        textarea::placeholder {
            color: #7e818a;
        }

        .icon-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--zinc-400);
            cursor: pointer;
            padding: 8px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
        }

        .icon-btn:hover {
            background-color: var(--zinc-800);
            border-color: var(--zinc-600);
            color: var(--zinc-100);
        }

        .send-btn {
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--line-strong);
            color: var(--zinc-100);
        }

        .send-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.24);
        }

        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
        }

        .thinking-indicator {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 2px 12px;
            width: fit-content;
            margin-top: 0;
            display: none;
        }

        .dot {
            width: 6px;
            height: 6px;
            background-color: var(--zinc-400);
            border-radius: 50%;
            animation: pulse 1.4s infinite ease-in-out both;
        }

        .dot:nth-child(1) { animation-delay: -0.32s; }
        .dot:nth-child(2) { animation-delay: -0.16s; }

        @keyframes pulse {
            0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
            40% { transform: scale(1); opacity: 1; }
        }

        pre {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.09);
            border-radius: 8px;
            padding: 10px 12px;
            overflow-x: auto;
            margin: 8px 0 2px;
        }
        code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
            font-size: 12px;
        }
        .content pre code {
            display: block;
            white-space: pre;
            line-height: 1.55;
        }
        .content p {
            margin: 6px 0;
        }
        .content h1,
        .content h2,
        .content h3,
        .content h4,
        .content h5,
        .content h6 {
            color: var(--zinc-100);
            margin: 12px 0 6px;
            line-height: 1.35;
        }
        .content h1 { font-size: 17px; }
        .content h2 { font-size: 16px; }
        .content h3 { font-size: 15px; }
        .content h4 { font-size: 14px; }
        .content h5,
        .content h6 { font-size: 13px; }
        .content ul,
        .content ol {
            margin: 6px 0 8px 16px;
            padding: 0;
        }
        .content li {
            margin: 2px 0;
        }
        .content strong {
            color: var(--zinc-100);
            font-weight: 650;
        }
        .content em {
            font-style: italic;
        }
        .content blockquote {
            margin: 8px 0;
            padding: 6px 10px;
            border-left: 2px solid var(--line-strong);
            background: rgba(255, 255, 255, 0.03);
            border-radius: 0 6px 6px 0;
        }
        .content hr {
            border: 0;
            border-top: 1px solid var(--line);
            margin: 10px 0;
        }
        p { margin: 6px 0; }

        .edit-badge {
            display: inline-block;
            font-size: 10px;
            font-weight: 600;
            color: #e4e4e7;
            border: 1px solid rgba(228, 228, 231, 0.18);
            background: rgba(228, 228, 231, 0.06);
            padding: 2px 6px;
            border-radius: 4px;
            margin-top: 6px;
        }

        .attachments {
            margin-top: 8px;
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: var(--zinc-400);
            text-align: center;
            opacity: 0;
            animation: slideUpFade 0.5s forwards;
            animation-delay: 0.2s;
            padding: 0 18px;
            line-height: 1.6;
            max-width: 360px;
            margin: 0 auto;
        }

        .logo {
            font-size: 16px;
            margin-bottom: 10px;
            color: var(--zinc-300);
            border: 1px solid var(--line-strong);
            border-radius: 999px;
            padding: 2px 10px;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
        }

        .empty-state h3 {
            margin: 0 0 6px;
            color: var(--zinc-100);
            font-size: 14px;
            font-weight: 600;
        }

        .empty-state p {
            margin: 0;
            font-size: 12px;
            max-width: 250px;
        }

        @media (max-width: 560px) {
            .quick-actions {
                padding: 10px;
                gap: 8px;
            }

            .action-btn {
                font-size: 10px;
                padding: 7px 10px;
            }

            .chat-scroll-area {
                padding: 12px 12px 2px;
            }

            .chat-list {
                gap: 16px;
            }

            .message.assistant {
                padding-right: 3%;
            }

            .message.user .content {
                max-width: 100%;
                padding: 9px 11px;
            }

            .input-container {
                padding: 10px 10px 12px;
            }

            .input-box {
                border-radius: 10px;
                padding: 8px 8px 7px;
            }

            textarea {
                font-size: 12px;
                line-height: 1.6;
            }

            .empty-state h3 {
                font-size: 13px;
            }

            .empty-state p {
                font-size: 11px;
            }
        }

        @media (max-width: 360px) {
            .quick-actions {
                flex-wrap: wrap;
            }

            .input-row {
                gap: 4px;
            }

            .icon-btn {
                padding: 6px;
            }
        }
    </style>
</head>
<body>

    <div class="quick-actions">
        <button class="action-btn" onclick="triggerCommand('alloyai.fixError')">Fix Last Error</button>
        <button class="action-btn" onclick="triggerCommand('alloyai.explainCode')">Explain Code</button>
    </div>

    <div class="chat-scroll-area">
        <div id="chat-list" class="chat-list is-empty">
            <div id="empty-state" class="empty-state">
                <div class="logo">Alloy AI</div>
                <h3>How can I help you ship today?</h3>
                <p>I can search your codebase, explain logic, and perform file edits.</p>
            </div>
        </div>

        <div id="thinking" class="thinking-indicator">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
        </div>
    </div>

    <div class="input-container">
        <div class="input-box">
            <div id="files-preview" class="files-preview"></div>

            <div class="input-row">
                <textarea id="message-input" rows="1" placeholder="Message Alloy AI..."></textarea>

                <button id="attach-btn" class="icon-btn" title="Attach Context">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/>
                    </svg>
                </button>

                <button id="send-btn" class="icon-btn send-btn" title="Send Message" disabled>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M2 8.5L13.2 2.2c.4-.2.8.2.7.6L11.3 13c-.1.5-.7.6-1 .2L7.5 9.9l-3.1.6c-.5.1-.8-.5-.4-1z"/>
                    </svg>
                </button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatList = document.getElementById('chat-list');
        const messageInput = document.getElementById('message-input');
        const attachBtn = document.getElementById('attach-btn');
        const sendBtn = document.getElementById('send-btn');
        const filesPreview = document.getElementById('files-preview');
        const thinkingIndicator = document.getElementById('thinking');
        const emptyState = document.getElementById('empty-state');

        let attachedFiles = []; 
        let isLoading = false;

        function updateSendState() {
            sendBtn.disabled = isLoading || (messageInput.value.trim().length === 0 && attachedFiles.length === 0);
        }

        // Auto-grow textarea
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 150) + 'px';
            updateSendState();
        });

        // Trigger Commands
        function triggerCommand(commandId) {
            vscode.postMessage({ type: 'executeCommand', command: commandId });
        }

        // Handle File Picking
        attachBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'pickFile' });
        });

        // Send Logic
        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text && attachedFiles.length === 0) return;

            vscode.postMessage({ 
                type: 'sendMessage', 
                message: text, 
                attachedFiles: attachedFiles.map(f => f.path) 
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
            attachedFiles = [];
            renderFiles();
            updateSendState();

            if (emptyState) emptyState.style.display = 'none';
            chatList.classList.remove('is-empty');
        }

        sendBtn.addEventListener('click', sendMessage);
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Event Listener for Extension Messages
        window.addEventListener('message', event => {
            const msg = event.data;

            switch (msg.type) {
                case 'filePicked':
                    msg.files.forEach(f => attachedFiles.push(f));
                    renderFiles();
                    updateSendState();
                    break;
                case 'userMessage':
                    appendMessage('user', msg.message, msg.files);
                    scrollToBottom();
                    break;
                case 'assistantMessage':
                    appendMessage('assistant', msg.message, null, msg.editedFiles);
                    scrollToBottom();
                    break;
                case 'addHistory':
                    if (emptyState) emptyState.style.display = 'none';
                    chatList.classList.remove('is-empty');
                    appendMessage('user', msg.query, msg.files);
                    appendMessage('assistant', msg.response);
                    break;
                case 'setLoading':
                    thinkingIndicator.style.display = msg.value ? 'flex' : 'none';
                    scrollToBottom();
                    isLoading = msg.value;
                    if (msg.value) {
                        messageInput.disabled = true;
                    } else {
                        messageInput.disabled = false;
                        setTimeout(() => messageInput.focus(), 100);
                    }
                    updateSendState();
                    break;
                case 'reset':
                    chatList.innerHTML = '';
                    attachedFiles = [];
                    renderFiles();
                    if (emptyState) {
                        chatList.appendChild(emptyState);
                        emptyState.style.display = 'flex';
                        chatList.classList.add('is-empty');
                    }
                    updateSendState();
                    break;
            }
        });

        function renderFiles() {
            filesPreview.innerHTML = '';
            attachedFiles.forEach((f, idx) => {
                const chip = document.createElement('div');
                chip.className = 'file-chip';
                chip.innerHTML = \`
                    <span>\${f.name}</span>
                    <span class="remove-file" onclick="removeFile(\${idx})">&times;</span>
                \`;
                filesPreview.appendChild(chip);
            });
        }

        // Expose removeFile to global scope for onclick
        window.removeFile = (idx) => {
            attachedFiles.splice(idx, 1);
            renderFiles();
            updateSendState();
        };

        const KNOWN_LANGUAGES = new Set([
            'python', 'javascript', 'typescript', 'tsx', 'jsx', 'json', 'bash', 'sh',
            'powershell', 'pwsh', 'java', 'c', 'cpp', 'csharp', 'cs', 'go', 'rust',
            'php', 'ruby', 'swift', 'kotlin', 'sql', 'html', 'css', 'xml', 'yaml', 'yml'
        ]);

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function renderInlineMarkdown(line) {
            const escaped = escapeHtml(line);
            return escaped
                .replace(/\\\`([^\\\`\\n]+)\\\`/g, '<code>$1</code>')
                .replace(/\\\*\\\*([^\\\*\\n]+)\\\*\\\*/g, '<strong>$1</strong>')
                .replace(/__([^_\\n]+)__/g, '<strong>$1</strong>')
                .replace(/\\\*([^\\\*\\n]+)\\\*/g, '<em>$1</em>')
                .replace(/_([^_\\n]+)_/g, '<em>$1</em>');
        }

        function isCodeLikeLine(line) {
            if (!line.trim()) return false;
            if (/^\\s{4,}\\S/.test(line)) return true;
            if (/^[\\t ]*(import|from|def|class|return|const|let|var|if|for|while|try|catch|switch|function|public|private|protected)\\b/.test(line)) return true;
            if (/[{}()[\\];=]|=>/.test(line)) return true;
            return false;
        }

        function normalizePseudoCodeBlocks(source) {
            const lines = source.split('\\n');
            const normalized = [];

            for (let i = 0; i < lines.length; i++) {
                const current = lines[i];
                const language = current.trim().toLowerCase();

                if (!KNOWN_LANGUAGES.has(language)) {
                    normalized.push(current);
                    continue;
                }

                let j = i + 1;
                const blockLines = [];
                while (j < lines.length && lines[j].trim() !== '') {
                    blockLines.push(lines[j]);
                    j++;
                }

                const hasCode = blockLines.length > 0 && blockLines.some(isCodeLikeLine);
                if (!hasCode) {
                    normalized.push(current);
                    continue;
                }

                normalized.push(\`\\\`\\\`\\\`\${language}\`);
                normalized.push(...blockLines);
                normalized.push('\\\`\\\`\\\`');
                i = j - 1;
            }

            return normalized.join('\\n');
        }

        function renderCodeBlock(language, code) {
            const safeLanguage = language ? escapeHtml(language) : '';
            const safeCode = escapeHtml(code.replace(/\\n$/, ''));
            return \`<pre><code class="language-\${safeLanguage}">\${safeCode}</code></pre>\`;
        }

        function formatMessageText(rawText) {
            const input = normalizePseudoCodeBlocks(String(rawText ?? '').replace(/\\u00A0/g, ' ').replace(/\\r\\n/g, '\\n'));
            if (!input.trim()) return '';

            const codeBlocks = [];
            const withPlaceholders = input.replace(/\\\`\\\`\\\`([^\\n\\\`]*)\\n?([\\s\\S]*?)\\\`\\\`\\\`/g, (_, language, code) => {
                const token = \`@@ALLOY_CODE_BLOCK_\${codeBlocks.length}@@\`;
                codeBlocks.push({ language: String(language || '').trim(), code: String(code || '') });
                return token;
            });

            const lines = withPlaceholders.split('\\n');
            const htmlParts = [];
            let paragraph = [];
            let openList = '';
            let inQuote = false;

            const flushParagraph = () => {
                if (paragraph.length === 0) return;
                const joined = paragraph.map(renderInlineMarkdown).join('<br>');
                htmlParts.push(\`<p>\${joined}</p>\`);
                paragraph = [];
            };

            const closeList = () => {
                if (!openList) return;
                htmlParts.push(\`</\${openList}>\`);
                openList = '';
            };

            const closeQuote = () => {
                if (!inQuote) return;
                htmlParts.push('</blockquote>');
                inQuote = false;
            };

            for (const rawLine of lines) {
                const trimmed = rawLine.trim();

                const codeMatch = trimmed.match(/^@@ALLOY_CODE_BLOCK_(\\d+)@@$/);
                if (codeMatch) {
                    flushParagraph();
                    closeList();
                    closeQuote();
                    const block = codeBlocks[Number(codeMatch[1])];
                    if (block) htmlParts.push(renderCodeBlock(block.language, block.code));
                    continue;
                }

                if (!trimmed) {
                    flushParagraph();
                    closeList();
                    closeQuote();
                    continue;
                }

                const headingMatch = trimmed.match(/^(#{1,6})\\s+(.+)$/);
                if (headingMatch) {
                    flushParagraph();
                    closeList();
                    closeQuote();
                    const level = headingMatch[1].length;
                    htmlParts.push(\`<h\${level}>\${renderInlineMarkdown(headingMatch[2].trim())}</h\${level}>\`);
                    continue;
                }

                if (/^(-{3,}|\\*{3,}|_{3,})$/.test(trimmed)) {
                    flushParagraph();
                    closeList();
                    closeQuote();
                    htmlParts.push('<hr>');
                    continue;
                }

                const ulMatch = trimmed.match(/^[-\\*+]\\s+(.+)$/);
                if (ulMatch) {
                    flushParagraph();
                    closeQuote();
                    if (openList !== 'ul') {
                        closeList();
                        openList = 'ul';
                        htmlParts.push('<ul>');
                    }
                    htmlParts.push(\`<li>\${renderInlineMarkdown(ulMatch[1].trim())}</li>\`);
                    continue;
                }

                const olMatch = trimmed.match(/^\\d+\\.\\s+(.+)$/);
                if (olMatch) {
                    flushParagraph();
                    closeQuote();
                    if (openList !== 'ol') {
                        closeList();
                        openList = 'ol';
                        htmlParts.push('<ol>');
                    }
                    htmlParts.push(\`<li>\${renderInlineMarkdown(olMatch[1].trim())}</li>\`);
                    continue;
                }

                const quoteMatch = trimmed.match(/^>\\s?(.*)$/);
                if (quoteMatch) {
                    flushParagraph();
                    closeList();
                    if (!inQuote) {
                        htmlParts.push('<blockquote>');
                        inQuote = true;
                    }
                    const body = quoteMatch[1].trim();
                    if (body) htmlParts.push(\`<p>\${renderInlineMarkdown(body)}</p>\`);
                    continue;
                }

                closeQuote();
                paragraph.push(rawLine.trim());
            }

            flushParagraph();
            closeList();
            closeQuote();

            return htmlParts.join('');
        }

        function appendMessage(role, text, files = [], editedFiles = []) {
            const msgDiv = document.createElement('div');
            msgDiv.className = \`message \${role}\`;
            chatList.classList.remove('is-empty');

            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = role === 'assistant' ? 'Alloy AI' : 'You';
            msgDiv.appendChild(meta);

            if (role === 'assistant') {
                // Assistant messages intentionally use whitespace separation with no strong bubble.
            }

            const contentDiv = document.createElement('div');
            contentDiv.className = 'content';
            contentDiv.innerHTML = formatMessageText(text);

            // Attachments Display in Bubble
            if (files && files.length > 0) {
                const fileContainer = document.createElement('div');
                fileContainer.className = 'attachments';

                files.forEach(f => {
                    const fileBadge = document.createElement('span');
                    fileBadge.className = 'file-chip';
                    fileBadge.innerText = f;
                    fileContainer.appendChild(fileBadge);
                });
                contentDiv.appendChild(fileContainer);
            }

            // Edit Badges
            if (editedFiles && editedFiles.length > 0) {
                const editDiv = document.createElement('div');
                editDiv.style.marginTop = '8px';
                editedFiles.forEach(f => {
                    const badge = document.createElement('div');
                    badge.className = 'edit-badge';
                    badge.innerText = 'EDITED: ' + f;
                    editDiv.appendChild(badge);
                });
                contentDiv.appendChild(editDiv);
            }

            msgDiv.appendChild(contentDiv);
            chatList.appendChild(msgDiv);
        }

        function scrollToBottom() {
            const scrollArea = document.querySelector('.chat-scroll-area');
            scrollArea.scrollTop = scrollArea.scrollHeight;
        }
    </script>
</body>
</html>`;
    }
}
