export function getWebviewContent(title: string, content: string) {
    const formattedContent = formatMarkdown(content);

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <style>
            :root {
                --bg-color: var(--vscode-editor-background);
                --text-color: var(--vscode-editor-foreground);
                --link-color: var(--vscode-textLink-foreground);
                --code-bg: var(--vscode-textBlockQuote-background);
                --border-color: var(--vscode-widget-border);
            }
            body {
                font-family: var(--vscode-font-family), "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
                font-size: var(--vscode-editor-font-size);
                line-height: 1.6;
                color: var(--text-color);
                background-color: var(--bg-color);
                padding: 20px;
                max-width: 900px;
                margin: 0 auto;
            }
            h1, h2, h3 {
                font-weight: 600;
                color: var(--vscode-editor-foreground);
                margin-top: 1.5em;
                margin-bottom: 0.5em;
                border-bottom: 1px solid var(--border-color);
                padding-bottom: 5px;
            }
            h1 { font-size: 1.5em; }
            h2 { font-size: 1.3em; }
            h3 { font-size: 1.1em; border: none; }
            p { margin-bottom: 1em; }
            strong { color: var(--vscode-textPreformat-foreground); font-weight: 700; }
            code {
                font-family: 'Courier New', Courier, monospace;
                background-color: var(--code-bg);
                padding: 2px 4px;
                border-radius: 4px;
                font-size: 0.9em;
            }
            pre {
                background-color: var(--code-bg);
                padding: 15px;
                border-radius: 6px;
                overflow-x: auto;
                border: 1px solid var(--border-color);
            }
            pre code { background-color: transparent; padding: 0; font-size: 0.9em; color: var(--vscode-editor-foreground); }
            .container { animation: fadeIn 0.3s ease-in-out; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>${title}</h1>
            ${formattedContent}
        </div>
    </body>
    </html>`;
}

function formatMarkdown(text: string): string {
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    html = html.split('\n\n').map(p => {
        if (p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<pre')) return p;
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    return html;
}