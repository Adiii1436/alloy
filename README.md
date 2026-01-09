# Alloy

**Alloy** is an **AI Pair Debugger** for VS Code designed to solve one specific problem: the tedious cycle of copying stack traces from your terminal and pasting them into ChatGPT or Claude.

> Stop copy-pasting errors. Start fixing them.

## Overview

Unlike generic AI assistants that require you to manually explain the context or provide the error logs, Alloy autonomously monitors your terminal and Problems Tab. It traces the error back to its source-even if that source is in a completely different file-and suggests the precise fix.

<img alt="reset_ui" src="media/demo_1.gif" />

## Key Capabilities

### 1. Automated Error Capture

Never manually copy a stack trace again.

- **Terminal Integration:** Alloy reads your active terminal to catch runtime crashes and exceptions.
- **Linter Integration:** It scans the Problems tab to catch syntax errors before you even run the code.

### 2. Root Cause Analysis

A bug in your `main.ts` is often caused by a definition in `worker.ts`.

- Standard assistants fix the active file (which might be wrong).
- **Alloy follows the trail.** It identifies the actual file causing the crash, opens it, and generates the fix right there.

### 3. Privacy-First Design

Your project structure is analyzed locally on your machine.
- **Selective Sharing:** Only the specific code related to the error is sent to the AI for analysis. Your full codebase is never uploaded.
- **Ignore Lists:** Easily exclude folders like `secrets/` or `node_modules/` from being tracked.


## Getting Started

### 1. Installation

Install Alloy from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=aditya-anand.alloyai).

### 2. Let it scan

When you open a folder, Alloy quickly scans your file structure to build its local understanding. This happens once and enables it to find connections between files instantly.

### 3. Connect AI

Alloy powers its debugging engine using Gemini/OpenAI models.

1. Run any command (e.g., `Ctrl+Shift+P` -> `AI: Fix Error`).
2. Enter your free API Key from [Google AI Studio](https://aistudio.google.com/) when prompted.

## Usage

### Fix a Crash

1. **Scenario:** Your terminal is red with errors, or your code isn't compiling.
2. **Action:** Open the Command Palette (`Ctrl+Shift+P`) and run `AI: Fix Error`.
3. **Result:** Alloy analyzes the log, jumps to the broken file, and presents a diff view with the solution. You can accept or reject the change.

### Understand Complex Logic

- **Action:** Run `AI: Explain Code`.
- **Result:** Alloy breaks down the current file or selection, explaining why it works and how it interacts with other parts of your app.

### Manage Settings

Run `AI: Reset Settings` to open the dashboard:

<img alt="reset_ui" src="media/reset_ui.png" />

- **Reset API Key:** Change your AI credentials.
- **Rebuild Index:** Force a re-scan of the project structure.
- **Manage Ignore List:** Exclude files/folders from Alloy's view.

## FAQ

**Q: Will Alloy write my entire app?**

A: No. Alloy is an AI Debugger. Its primary goal is to unblock you when you are stuck on an error. It is designed to fix broken code, not generate new features from zero.

**Q: Why is this better than copy-pasting to ChatGPT?**

A: Alloy has context. ChatGPT doesn't know you have a `utils.ts` file that defines the function breaking your `main.ts`. Alloy sees that connection automatically and fixes the root cause without you needing to explain the project structure.

**Q: Does it work with my language?**

A: Yes. Alloy's error parser is universal and supports Python, JavaScript, TypeScript, Go, Rust, Java, C++, and many others.

---

**Debug smarter, not harder:**
*The Alloy Team*
