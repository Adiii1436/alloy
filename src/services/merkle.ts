import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';

// --- CONSTANTS & REGEX (Compiled Once) ---

const DEFAULT_IGNORES = [
    '**/node_modules/**', '**/bower_components/**', '**/dist/**', '**/out/**', '**/build/**',
    '**/.venv/**', '**/venv/**', '**/env/**', '**/__pycache__/**', '**/*.pyc', '**/*.pyo',
    '**/target/**', '**/bin/**', '**/obj/**', '**/vendor/**',
    '**/.git/**', '**/.svn/**', '**/.idea/**', '**/.vscode/**', '**/.DS_Store',
    '**/*.min.js', '**/*.map', '**/*.svg', '**/*.png', '**/*.jpg', '**/*.json', '**/*.lock', '**/*.log'
];

const SUPPORTED_EXTENSIONS = [
    '', '.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs',
    '.py', '.pyw', '.java', '.kt', '.scala',
    '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs',
    '.php', '.rb', '.swift', '.dart', '.lua'
];

const STOP_WORDS = new Set([
    'const', 'let', 'var', 'function', 'class', 'import', 'from', 'return',
    'async', 'await', 'if', 'else', 'for', 'while', 'try', 'catch', 'new',
    'this', 'true', 'false', 'null', 'undefined', 'export', 'default',
    'interface', 'type', 'module', 'require', 'include', 'package', 'namespace',
    'public', 'private', 'protected', 'void', 'int', 'string', 'bool'
]);

// Regex Patterns
const REGEX_DEF = /(?:function|class|def|func|fn|fun|struct|interface|enum|trait|type|impl|module|package)\s+([a-zA-Z0-9_]+)/g;
const REGEX_IMPORT_QUOTED = /(?:import|from|require|include|use)\s+(?:[\w\s{},*]*)\s*['"]([^'"]+)['"]/g;
const REGEX_IMPORT_ANGLE = /#include\s+<([^>]+)>/g;
const REGEX_IMPORT_PYTHON = /^(?:from|import)\s+([a-zA-Z0-9_.]+)/gm;

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
    private dependencyMap: Map<string, string[]> = new Map();

    constructor(private workspaceRoot: string, private customIgnores: string[] = []) { }

    async refreshIndex(): Promise<void> {
        console.log("Refreshing Polyglot Merkle Index...");
        const finalIgnores = [...DEFAULT_IGNORES, ...this.customIgnores];

        try {
            const files = await glob('**/*', {
                cwd: this.workspaceRoot,
                ignore: finalIgnores,
                nodir: true
            });

            this.root = await this.buildTree(this.workspaceRoot, files);
            if (this.root) console.log(`Index Updated. Symbols: ${this.symbolMap.size}, Deps: ${this.dependencyMap.size}`);
        } catch (error) {
            console.error("❌ Indexing Failed:", error);
        }
    }

    private async buildTree(currentPath: string, allFiles: string[]): Promise<MerkleNode> {
        try { await fs.access(currentPath); } catch { return { hash: '', path: currentPath, type: 'directory', children: [] }; }

        const stats = await fs.stat(currentPath);

        if (stats.isFile()) {
            if (stats.size > 500 * 1024) return { hash: 'skipped_large', path: currentPath, type: 'file' }; // Skip > 500KB

            try {
                const content = await fs.readFile(currentPath, 'utf-8');
                const hash = this.computeHash(content);
                const cachedHash = this.hashMap.get(currentPath);

                if (cachedHash !== hash) {
                    this.hashMap.set(currentPath, hash);
                    this.indexContent(currentPath, content);
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
                this.indexContent(fullPath, content);
            }
            return { hash, path: fullPath, type: 'file' };
        } catch {
            return null;
        }
    }

    private computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private indexContent(filePath: string, content: string) {
        const fileName = path.parse(filePath).name;

        // 1. Index Definitions
        let match;
        while ((match = REGEX_DEF.exec(content)) !== null) this.addSymbol(match[1], filePath);

        // 2. Index Dependencies
        const dependencies: string[] = [];

        // A. Quoted Imports
        while ((match = REGEX_IMPORT_QUOTED.exec(content)) !== null) {
            const resolved = this.resolveImportPath(filePath, match[1]);
            if (resolved) dependencies.push(resolved);
        }

        // B. Angle Bracket Imports
        while ((match = REGEX_IMPORT_ANGLE.exec(content)) !== null) {
            const resolved = this.resolveImportPath(filePath, match[1]);
            if (resolved) dependencies.push(resolved);
        }

        // C. Python Style
        while ((match = REGEX_IMPORT_PYTHON.exec(content)) !== null) {
            const rawPath = match[1].replace(/\./g, '/');
            const resolved = this.resolveImportPath(filePath, rawPath);
            if (resolved) dependencies.push(resolved);
        }

        this.dependencyMap.set(filePath, dependencies);
    }

    private addSymbol(symbol: string, filePath: string) {
        if (symbol.length < 3 || STOP_WORDS.has(symbol)) return;
        const existing = this.symbolMap.get(symbol) || [];
        if (!existing.includes(filePath)) existing.push(filePath);
        this.symbolMap.set(symbol, existing);
    }

    private resolveImportPath(currentFile: string, importPath: string): string | null {
        try {
            const dir = path.dirname(currentFile);
            const baseResolved = path.resolve(dir, importPath);

            if (this.hashMap.has(baseResolved)) return baseResolved;

            for (const ext of SUPPORTED_EXTENSIONS) {
                const testPath = baseResolved + ext;
                if (this.hashMap.has(testPath)) return testPath;
            }

            // Check index files
            const indexExtensions = ['/index.js', '/index.ts', '/__init__.py', '/main.go', '/mod.rs'];
            for (const idx of indexExtensions) {
                const testPath = baseResolved + idx;
                if (this.hashMap.has(testPath)) return testPath;
            }

            return null;
        } catch {
            return null;
        }
    }

    public async findRelevantContext(query: string): Promise<string> {
        const fileScores = new Map<string, number>();
        const queryTokens = query.split(/[^a-zA-Z0-9_.-]+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
        const uniqueTokens = new Set(queryTokens);

        // 1. Boost Stack Trace Matches
        const allIndexedFiles = Array.from(this.hashMap.keys());
        const explicitFiles = allIndexedFiles.filter(f => {
            const base = path.basename(f);
            return query.includes(base) || query.includes(f);
        });
        explicitFiles.forEach(f => fileScores.set(f, 100));

        // 2. Symbol Scoring
        uniqueTokens.forEach(token => {
            const filesWithSymbol = this.symbolMap.get(token);
            if (filesWithSymbol) {
                const weight = 10 / (filesWithSymbol.length + 1);
                filesWithSymbol.forEach(filePath => {
                    const current = fileScores.get(filePath) || 0;
                    fileScores.set(filePath, current + weight);
                });
            }
        });

        const sortedFiles = Array.from(fileScores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0]);

        // 3. Graph Expansion
        const topMatches = sortedFiles.slice(0, 3);
        const expandedFiles = new Set<string>(topMatches);

        for (const file of topMatches) {
            const imports = this.dependencyMap.get(file) || [];
            imports.forEach(dep => expandedFiles.add(dep));
        }

        const filesToRead = Array.from(expandedFiles).slice(0, 8); // Max 8 files
        if (filesToRead.length === 0) return "No correlated files found.";

        const contents = await Promise.all(filesToRead.map(async (filePath) => {
            try {
                const relativePath = path.relative(this.workspaceRoot, filePath);
                const content = await fs.readFile(filePath, 'utf-8');
                return `\n\n--- RELATED FILE: ${relativePath} ---\n${content}\n`;
            } catch {
                return "";
            }
        }));

        return contents.join("");
    }
}