import * as vscode from 'vscode';

export class AIActionProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }
    getChildren(): vscode.TreeItem[] {
        const items: vscode.TreeItem[] = [];

        const fixItem = new vscode.TreeItem('Fix Last Error', vscode.TreeItemCollapsibleState.None);
        fixItem.command = { command: 'alloy.fixError', title: 'Fix Error' };
        fixItem.iconPath = new vscode.ThemeIcon('debug-disconnect');
        items.push(fixItem);

        const explainItem = new vscode.TreeItem('Explain Code', vscode.TreeItemCollapsibleState.None);
        explainItem.command = { command: 'alloy.explainCode', title: 'Explain Code' };
        explainItem.iconPath = new vscode.ThemeIcon('book');
        items.push(explainItem);

        const optimizeItem = new vscode.TreeItem('Optimize Code', vscode.TreeItemCollapsibleState.None);
        optimizeItem.command = { command: 'alloy.optimizeCode', title: 'Optimize Code' };
        optimizeItem.iconPath = new vscode.ThemeIcon('zap');
        items.push(optimizeItem);

        return items;
    }
}