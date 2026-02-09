import * as vscode from 'vscode';
import { GlobalState } from './globalState';
import { AgentChatViewProvider } from './ui/agentChatViewProvider';
import { runAnalysisFlow } from './commands/analysis';
import { manageIgnoreList, handleResetSettings } from './commands/settings';
import { initializeIndexer } from './services/indexerManager';

const COMMANDS = {
	fixError: 'alloyai.fixError',
	explainCode: 'alloyai.explainCode',
	manageIgnores: 'alloyai.manageIgnores',
	resetSettings: 'alloyai.resetSettings',
	openChat: 'alloyai.openChat',
	chatViewFocus: 'agentChat.chatView.focus'
} as const;

type CommandHandler = (...args: unknown[]) => unknown;

function registerCommands(context: vscode.ExtensionContext): void {
	const commandHandlers: Array<[string, CommandHandler]> = [
		[COMMANDS.fixError, () => runAnalysisFlow('fix')],
		[COMMANDS.explainCode, () => runAnalysisFlow('explain')],
		[COMMANDS.manageIgnores, () => manageIgnoreList()],
		[COMMANDS.resetSettings, () => handleResetSettings()],
		[COMMANDS.openChat, () => vscode.commands.executeCommand(COMMANDS.chatViewFocus)]
	];

	context.subscriptions.push(
		...commandHandlers.map(([commandId, handler]) =>
			vscode.commands.registerCommand(commandId, handler)
		)
	);
}

export function activate(context: vscode.ExtensionContext) {
	GlobalState.context = context;
	console.log('Alloy (AI Pair Debugger) is active!');

	GlobalState.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	context.subscriptions.push(GlobalState.statusBarItem);

	void initializeIndexer().catch(err => console.error('Indexer Initialization Failed:', err));

	const chatProvider = new AgentChatViewProvider(context.extensionUri);
	GlobalState.agentChatProvider = chatProvider;

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			AgentChatViewProvider.viewType,
			chatProvider
		)
	);

	registerCommands(context);
}

export function deactivate() { }
