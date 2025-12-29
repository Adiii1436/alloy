import * as vscode from 'vscode';
import { GlobalState } from './globalState';
import { AIActionProvider } from './ui/sidebar';
import { runAnalysisFlow } from './commands/analysis';
import { manageIgnoreList, handleResetSettings } from './commands/settings';
import { initializeIndexer } from './services/indexerManager';

export function activate(context: vscode.ExtensionContext) {
	GlobalState.context = context;
	console.log('Alloy (AI Pair Debugger) is active!');

	GlobalState.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	context.subscriptions.push(GlobalState.statusBarItem);

	initializeIndexer();

	const sidebarProvider = new AIActionProvider();
	vscode.window.registerTreeDataProvider('ai-programmer-view', sidebarProvider);

	context.subscriptions.push(vscode.commands.registerCommand('alloy.analyze', async () => await runAnalysisFlow('explain')));
	context.subscriptions.push(vscode.commands.registerCommand('alloy.fixError', async () => await runAnalysisFlow('fix')));
	context.subscriptions.push(vscode.commands.registerCommand('alloy.explainCode', async () => await runAnalysisFlow('explain')));
	context.subscriptions.push(vscode.commands.registerCommand('alloy.optimizeCode', async () => await runAnalysisFlow('optimize')));
	context.subscriptions.push(vscode.commands.registerCommand('alloy.manageIgnores', async () => await manageIgnoreList()));
	context.subscriptions.push(vscode.commands.registerCommand('alloy.resetSettings', async () => await handleResetSettings()));
}

export function deactivate() { }