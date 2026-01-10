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
        quickPick.hide();
        if (selection.type === 'add') {
            const newList = [...currentIgnores, selection.value];
            await GlobalState.context.workspaceState.update('custom_ignores', newList);
            await initializeIndexer(true);
            vscode.window.showInformationMessage(`Added "${selection.value}" to ignore list.`);
        } else if (selection.type === 'remove') {
            const newList = currentIgnores.filter(p => p !== selection.value);
            await GlobalState.context.workspaceState.update('custom_ignores', newList);
            await initializeIndexer(true);
            vscode.window.showInformationMessage(`Removed "${selection.value}" from ignore list.`);
        }
    });
    quickPick.show();
}

export async function handleResetSettings() {
    const choice = await vscode.window.showQuickPick(
        [
            { label: '$(arrow-swap) Switch AI Provider', id: 'switch_provider' },
            { label: '$(settings) Change Model', id: 'change_model' },
            { label: '$(key) Reset API Key', id: 'reset_key' },
            { label: '$(database) Rebuild Index', id: 'index' },
            { label: '$(list-flat) Manage Ignore List', id: 'ignore' },
            { label: '$(trash) Factory Reset', id: 'all' }
        ],
        { placeHolder: 'Alloy Settings' }
    );
    if (!choice) return;

    if (choice.id === 'switch_provider') {
        await GlobalState.context.globalState.update('selected_provider', undefined);
        vscode.window.showInformationMessage('Provider selection cleared.');
    }
    if (choice.id === 'change_model') {
        const provider = GlobalState.context.globalState.get<AIProvider>('selected_provider');
        if (provider) await GlobalState.context.globalState.update(provider === 'Google Gemini' ? 'gemini_model' : 'openai_model', undefined);
    }
    if (choice.id === 'reset_key') {
        const provider = GlobalState.context.globalState.get<AIProvider>('selected_provider');
        if (provider) await GlobalState.context.globalState.update(provider === 'Google Gemini' ? 'gemini_key' : 'openai_key', undefined);
    }
    if (choice.id === 'ignore') await manageIgnoreList();
    if (choice.id === 'index') await initializeIndexer(true);
    if (choice.id === 'all') {
        await GlobalState.context.globalState.update('selected_provider', undefined);
        await GlobalState.context.globalState.update('gemini_key', undefined);
        await GlobalState.context.globalState.update('openai_key', undefined);
        await GlobalState.context.workspaceState.update('custom_ignores', undefined);
        vscode.window.showInformationMessage('Alloy has been factory reset.');
    }
}