import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';

const DEFAULT_IGNORES = [
    '**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**',
    '**/.venv/**', '**/venv/**', '**/env/**', '**/__pycache__/**',
    '**/.pytest_cache/**', '**/target/**', '**/bin/**', '**/obj/**',
    '**/*.min.js', '**/*.map', '**/*.svg', '**/*.png', '**/*.json',
    '**/*.lock', '**/*.log', '**/.DS_Store'
];

export interface MerkleNode {
    hash: string;
    path: string;
    type: 'file' | 'directory';
    children?: MerkleNode[];
}

export class CodebaseIndexer {
    private root: MerkleNode | null = null;
    private hashMap: Map<string, string> = new Map();
    private symbolMap: Map<string, string[]> = new Map();

    // [MODIFIED] Accept customIgnores in constructor
    constructor(private workspaceRoot: string, private customIgnores: string[] = []) { }

    async refreshIndex(): Promise<void> {
        console.log("♻️ Refreshing Merkle Index...");

        // [NEW] Combine defaults with user settings
        const finalIgnores = [...DEFAULT_IGNORES, ...this.customIgnores];

        try {
            const files = await glob('**/*', {
                cwd: this.workspaceRoot,
                ignore: finalIgnores, // Use the combined list
                nodir: true
            });

            this.root = await this.buildTree(this.workspaceRoot, files);
            if (this.root) console.log("✅ Index Updated. Root Hash:", this.root.hash.substring(0, 8));
        } catch (error) {
            console.error("❌ Indexing Failed:", error);
        }
    }

    private async buildTree(currentPath: string, allFiles: string[]): Promise<MerkleNode> {
        try {
            await fs.access(currentPath);
        } catch {
            return { hash: '', path: currentPath, type: 'directory', children: [] };
        }

        const stats = await fs.stat(currentPath);

        if (stats.isFile()) {
            if (stats.size > 500 * 1024) return { hash: 'skipped_large', path: currentPath, type: 'file' };

            try {
                const content = await fs.readFile(currentPath, 'utf-8');
                const hash = this.computeHash(content);
                const cachedHash = this.hashMap.get(currentPath);

                if (cachedHash !== hash) {
                    this.hashMap.set(currentPath, hash);
                    this.indexSymbols(currentPath, content);
                }
                return { hash, path: currentPath, type: 'file' };
            } catch {
                return { hash: 'error', path: currentPath, type: 'file' };
            }
        }

        const fileNodes: (MerkleNode | null)[] = [];
        const BATCH_SIZE = 50;

        for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
            const batch = allFiles.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async (f) => {
                const fullPath = path.join(this.workspaceRoot, f);
                return this.processFile(fullPath);
            }));
            fileNodes.push(...batchResults);
        }

        const validNodes = fileNodes.filter(n => n !== null) as MerkleNode[];
        const combinedHash = this.computeHash(validNodes.map(n => n.hash).join(''));

        return { hash: combinedHash, path: this.workspaceRoot, type: 'directory', children: validNodes };
    }

    private async processFile(fullPath: string): Promise<MerkleNode | null> {
        try {
            const stats = await fs.stat(fullPath);
            if (stats.size > 500 * 1024) return null;

            const content = await fs.readFile(fullPath, 'utf-8');
            const hash = this.computeHash(content);

            if (this.hashMap.get(fullPath) !== hash) {
                this.hashMap.set(fullPath, hash);
                this.indexSymbols(fullPath, content);
            }
            return { hash, path: fullPath, type: 'file' };
        } catch {
            return null;
        }
    }

    private computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private indexSymbols(filePath: string, content: string) {
        const fileName = path.parse(filePath).name;
        if (fileName && fileName.length > 2 && !['index', 'main', 'app'].includes(fileName.toLowerCase())) {
            this.addSymbol(fileName, filePath);
        }

        const defRegex = /(?:function|class|def|func|fn|fun|struct|interface|enum|trait|type|impl)\s+([a-zA-Z0-9_]+)/g;
        const arrowRegex = /(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\(|[a-zA-Z0-9_]+)\s*=>/g;

        let match;
        while ((match = defRegex.exec(content)) !== null) this.addSymbol(match[1], filePath);
        while ((match = arrowRegex.exec(content)) !== null) this.addSymbol(match[1], filePath);
    }

    private addSymbol(symbol: string, filePath: string) {
        if (symbol.length < 3) return;
        const existing = this.symbolMap.get(symbol) || [];
        if (!existing.includes(filePath)) {
            existing.push(filePath);
        }
        this.symbolMap.set(symbol, existing);
    }

    public async findRelevantContext(query: string): Promise<string> {
        const relevantFiles = new Set<string>();
        const queryTokens = new Set(query.split(/[^a-zA-Z0-9_]+/));

        queryTokens.forEach(token => {
            if (token.length < 3) return;
            const paths = this.symbolMap.get(token);
            if (paths) paths.forEach(p => relevantFiles.add(p));
        });

        const filesToRead = Array.from(relevantFiles).slice(0, 5);

        const contents = await Promise.all(filesToRead.map(async (filePath) => {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                return `\n\n--- RELATED FILE: ${path.basename(filePath)} ---\n${content}\n`;
            } catch {
                return "";
            }
        }));

        const finalContext = contents.join("");
        return finalContext.length > 0 ? finalContext : "No specific related files found in index.";
    }
}