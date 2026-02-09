import * as vscode from 'vscode';
import { CodebaseIndexer } from './services/merkle';
import { AgentChatViewProvider } from './ui/agentChatViewProvider';

export class GlobalState {
    private static _context: vscode.ExtensionContext;
    private static _statusBarItem: vscode.StatusBarItem;
    private static _indexer: CodebaseIndexer | null = null;
    private static _lastIndexTime: number = 0;
    private static _agentChatProvider: AgentChatViewProvider | undefined;

    static get context() { return this._context; }
    static set context(v: vscode.ExtensionContext) { this._context = v; }

    static get statusBarItem() { return this._statusBarItem; }
    static set statusBarItem(v: vscode.StatusBarItem) { this._statusBarItem = v; }

    static get indexer() { return this._indexer; }
    static set indexer(v: CodebaseIndexer | null) { this._indexer = v; }

    static get lastIndexTime() { return this._lastIndexTime; }
    static set lastIndexTime(v: number) { this._lastIndexTime = v; }

    static get agentChatProvider() { return this._agentChatProvider; }
    static set agentChatProvider(v: AgentChatViewProvider | undefined) { this._agentChatProvider = v; }
}