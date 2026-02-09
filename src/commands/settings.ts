import * as vscode from 'vscode';
import { GlobalState } from '../globalState';
import { initializeIndexer } from '../services/indexerManager';
import { AIProvider } from '../types';

export async function manageIgnoreList() {
    const currentIgnores = GlobalState.context.workspaceState.get<string[]>('custom_ignores', []);
    interface IgnoreItem extends vscode.QuickPickItem { type: 'add' | 'remove'; value: string; }

    const quickPick = vscode.window.createQuickPick<IgnoreItem>();
    quickPick.placeholder = 'Type a file path or pattern (e.g. "**/secrets/*")';
    quickPick.matchOnDescription = true;

    const updateItems = () => {
        const items: IgnoreItem[] = [];
        const filter = quickPick.value.trim();
        if (filter && !currentIgnores.includes(filter)) {
            items.push({ label: `$(plus) Add Pattern: "${filter}"`, description: 'Create new ignore rule', alwaysShow: true, type: 'add', value: filter });
        }
        items.push(...currentIgnores.map(pattern => ({ label: `$(trash) ${pattern}`, description: 'Current Rule', type: 'remove', value: pattern } as IgnoreItem)));
        quickPick.items = items;
    };
    updateItems();
    quickPick.onDidChangeValue(() => updateItems());
    quickPick.onDidAccept(async () => {
        const selection = quickPick.selectedItems[0];
        if (!selection) return;
        if (selection.type === 'add') {
            currentIgnores.push(selection.value);
            vscode.window.showInformationMessage(`Added ignore rule: ${selection.value}`);
        } else {
            const index = currentIgnores.indexOf(selection.value);
            if (index > -1) currentIgnores.splice(index, 1);
            vscode.window.showInformationMessage(`Removed ignore rule: ${selection.value}`);
        }
        await GlobalState.context.workspaceState.update('custom_ignores', currentIgnores);
        quickPick.value = '';
        updateItems();
    });
    quickPick.show();
}

export async function handleResetSettings() {
    const choice = await vscode.window.showQuickPick(
        [
            { label: '$(arrow-swap) Switch AI Provider', id: 'switch_provider' },
            { label: '$(edit) Change Model', id: 'change_model' },
            { label: '$(key) Update API Key', id: 'reset_key' },
            { label: '$(list-unordered) Manage Ignore List', id: 'ignore' },
            { label: '$(refresh) Re-Index Codebase', id: 'index' },
            { label: '$(trash) Factory Reset', id: 'all' }
        ],
        { placeHolder: 'Alloy Settings' }
    );
    if (!choice) return;

    if (choice.id === 'switch_provider') {
        await GlobalState.context.globalState.update('selected_provider', undefined);
        vscode.window.showInformationMessage('Provider selection cleared. Run any command to select again.');
    }
    if (choice.id === 'change_model') {
        const provider = GlobalState.context.globalState.get<AIProvider>('selected_provider');
        if (provider) {
            let key = 'openai_model';
            if (provider === 'Google Gemini') key = 'gemini_model';
            if (provider === 'Claude') key = 'claude_model';
            await GlobalState.context.globalState.update(key, undefined);
            vscode.window.showInformationMessage(`Model setting cleared for ${provider}.`);
        }
    }
    if (choice.id === 'reset_key') {
        const provider = GlobalState.context.globalState.get<AIProvider>('selected_provider');
        if (provider) {
            let key = 'openai_key';
            if (provider === 'Google Gemini') key = 'gemini_key';
            if (provider === 'Claude') key = 'anthropic_key';
            await GlobalState.context.globalState.update(key, undefined);
            vscode.window.showInformationMessage(`API Key cleared for ${provider}.`);
        }
    }
    if (choice.id === 'ignore') await manageIgnoreList();
    if (choice.id === 'index') await initializeIndexer(true);
    if (choice.id === 'all') {
        await GlobalState.context.globalState.update('selected_provider', undefined);
        await GlobalState.context.globalState.update('gemini_key', undefined);
        await GlobalState.context.globalState.update('openai_key', undefined);
        await GlobalState.context.globalState.update('anthropic_key', undefined);
        await GlobalState.context.globalState.update('gemini_model', undefined);
        await GlobalState.context.globalState.update('openai_model', undefined);
        await GlobalState.context.globalState.update('claude_model', undefined);
        await GlobalState.context.workspaceState.update('custom_ignores', undefined);
        vscode.window.showInformationMessage('Alloy has been factory reset.');
    }
}