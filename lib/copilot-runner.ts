import fs from "fs/promises";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { performance } from "perf_hooks";
import { copyFolder, ensureSharedDependencies } from "./eval-runner";

export interface CopilotResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  buildSuccess?: boolean;
  lintSuccess?: boolean;
  testSuccess?: boolean;
  buildOutput?: string;
  lintOutput?: string;
  testOutput?: string;
  evalPath?: string;
  timestamp?: string;
}

export interface CopilotEvalOptions {
  timeout?: number;
  verbose?: boolean;
  debug?: boolean;
  model?: string;
  outputFile?: string;
}

export class CopilotRunner {
  private processes = new Map<string, ChildProcess>();
  private verbose: boolean;
  private debug: boolean;
  private model?: string;

  constructor(options: CopilotEvalOptions = {}) {
    this.verbose = options.verbose || false;
    this.debug = options.debug || false;
    this.model = options.model;
  }

  async runCopilotEval(
    inputDir: string,
    outputDir: string,
    prompt: string,
    timeout: number = 600000 // 10 minutes default
  ): Promise<CopilotResult> {
    const startTime = performance.now();

    try {
      // Ensure output directory exists and copy input files
      await fs.mkdir(outputDir, { recursive: true });
      await copyFolder(inputDir, outputDir, true); // Exclude test files so Copilot doesn't see them

      // Ensure shared dependencies are available
      await ensureSharedDependencies(this.verbose);

      if (this.verbose) {
        console.log(`🤖 Running Copilot on ${outputDir}...`);
        console.log(`📝 Prompt: ${prompt}`);
        console.log('─'.repeat(80));
      }

      // Run Copilot with the prompt
      const copilotResult = await this.executeCopilot(outputDir, prompt, timeout);

      if (!copilotResult.success) {
        return {
          success: false,
          output: copilotResult.output,
          error: copilotResult.error,
          duration: performance.now() - startTime,
        };
      }

      // Copy test files and eslint config back for evaluation
      if (this.verbose) {
        console.log('📋 Copying test files and eslint config back for evaluation...');
      }
      await this.copyTestFilesBack(inputDir, outputDir);

      // Run evaluation (build, lint, test) on the modified code
      const evalResults = await this.runEvaluation(outputDir);

      return {
        success: true,
        output: copilotResult.output,
        duration: performance.now() - startTime,
        buildSuccess: evalResults.buildSuccess,
        lintSuccess: evalResults.lintSuccess,
        testSuccess: evalResults.testSuccess,
        buildOutput: evalResults.buildOutput,
        lintOutput: evalResults.lintOutput,
        testOutput: evalResults.testOutput,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        duration: performance.now() - startTime,
      };
    } finally {
      // Clean up if not in debug mode
      if (!this.debug) {
        try {
          await fs.rm(outputDir, { recursive: true, force: true });
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }
  }

  private async executeCopilot(
    projectDir: string,
    prompt: string,
    timeout: number
  ): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const processId = Math.random().toString(36).substr(2, 9);

      // Build the copilot command
      // --allow-all-tools: auto-approve all tool executions
      // --allow-all-paths: allow access to any path
      // -p <prompt>: non-interactive mode (prompt execution) - MUST be last with prompt
      const args = [
        '--allow-all-tools',
        '--allow-all-paths',
      ];

      // Add model flag if specified
      if (this.model) {
        args.push('--model', this.model);
      }

      // Append instruction to not run npm/pnpm commands to the prompt
      const enhancedPrompt = `${prompt}

IMPORTANT: Do not run npm, pnpm, yarn, or any package manager commands. Dependencies have already been installed. Do not run build, test, or dev server commands. Just write the code files.`;

      // Add -p flag and prompt as the last arguments
      args.push('-p', enhancedPrompt);

      console.log('🚀 Spawning copilot process with:');
      console.log('  Command: copilot');
      console.log('  Args:', args.slice(0, -1)); // Don't log the full prompt
      console.log('  Working Directory:', projectDir);
      if (this.model) {
        console.log('  Model:', this.model);
      }

      const copilotProcess = spawn('copilot', args, {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'] // ignore stdin since we're not sending any input
      });
      this.processes.set(processId, copilotProcess);

      let stdout = '';
      let stderr = '';

      copilotProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        if (this.verbose) {
          console.log('📝 Copilot stdout:', JSON.stringify(output));
        }
        stdout += output;
      });

      copilotProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        if (this.verbose) {
          console.log('⚠️  Copilot stderr:', JSON.stringify(output));
        }
        stderr += output;
      });

      const timeoutId = setTimeout(() => {
        copilotProcess.kill('SIGTERM');
        setTimeout(() => {
          copilotProcess.kill('SIGKILL');
        }, 5000);
        resolve({
          success: false,
          output: stdout,
          error: `Copilot process timed out after ${timeout}ms`
        });
      }, timeout);

      copilotProcess.on('exit', (code, signal) => {
        clearTimeout(timeoutId);
        this.processes.delete(processId);

        if (this.verbose) {
          console.log('─'.repeat(80));
          console.log(`Copilot finished with code: ${code}, signal: ${signal}`);
        }

        if (signal) {
          resolve({
            success: false,
            output: stdout,
            error: `Copilot process killed by signal ${signal}`
          });
        } else if (code === 0) {
          resolve({
            success: true,
            output: stdout
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Copilot process exited with code ${code}`
          });
        }
      });

      copilotProcess.on('error', (error) => {
        clearTimeout(timeoutId);
        this.processes.delete(processId);
        resolve({
          success: false,
          output: stdout,
          error: error.message
        });
      });
    });
  }

  private async copyTestFilesBack(inputDir: string, outputDir: string): Promise<void> {
    const entries = await fs.readdir(inputDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === "node_modules") {
        continue;
      }

      const isTestFile = entry.name.endsWith(".test.tsx") ||
                        entry.name.endsWith(".test.ts") ||
                        entry.name.endsWith(".spec.tsx") ||
                        entry.name.endsWith(".spec.ts") ||
                        entry.name.endsWith(".test.jsx") ||
                        entry.name.endsWith(".test.js") ||
                        entry.name.endsWith(".spec.jsx") ||
                        entry.name.endsWith(".spec.js");
      const isTestDir = entry.name === "__tests__" ||
                       entry.name === "test" ||
                       entry.name === "tests";
      const isEslintConfig = entry.name === ".eslintrc.json" ||
                            entry.name === ".eslintrc.js" ||
                            entry.name === ".eslintrc.cjs" ||
                            entry.name === ".eslintrc.yml" ||
                            entry.name === ".eslintrc.yaml" ||
                            entry.name === "eslint.config.js" ||
                            entry.name === "eslint.config.mjs" ||
                            entry.name === "eslint.config.cjs";

      const srcPath = path.join(inputDir, entry.name);
      const destPath = path.join(outputDir, entry.name);

      try {
        if (isTestFile || isEslintConfig) {
          // Copy the test file or eslint config
          await fs.copyFile(srcPath, destPath);
        } else if (entry.isDirectory() && isTestDir) {
          // Copy the test directory
          await copyFolder(srcPath, destPath, false); // Don't exclude anything when copying test dirs
        } else if (entry.isDirectory()) {
          // Recursively copy test files from subdirectories
          await this.copyTestFilesBack(srcPath, destPath);
        }
      } catch (error) {
        // Ignore errors (e.g., directory doesn't exist in output)
      }
    }
  }

  private async runEvaluation(projectDir: string): Promise<{
    buildSuccess: boolean;
    lintSuccess: boolean;
    testSuccess: boolean;
    buildOutput: string;
    lintOutput: string;
    testOutput: string;
  }> {
    let buildSuccess = false;
    let buildOutput = "";
    let lintSuccess = false;
    let lintOutput = "";
    let testSuccess = false;
    let testOutput = "";

    // Run next build
    try {
      if (this.verbose) {
        console.log("Running build...");
      }
      buildOutput = await this.execCommand(
        `cd "${projectDir}" && ../../node_modules/.bin/next build`,
        60000
      );
      buildSuccess = true;
      if (this.verbose) {
        console.log("✅ Build completed");
      }
    } catch (error) {
      if (error && typeof error === "object" && "stdout" in error) {
        buildOutput += (error as any).stdout || "";
        if ((error as any).stderr) {
          buildOutput += "\n" + (error as any).stderr;
        }
      } else {
        buildOutput += error instanceof Error ? error.message : String(error);
      }
      if (this.verbose) {
        console.log("❌ Build failed");
      }
    }

    // Run linting
    try {
      if (this.verbose) {
        console.log("Running lint...");
      }

      // Check if .eslintrc.json exists, create a basic one if not
      const eslintConfigPath = path.join(projectDir, ".eslintrc.json");
      const eslintConfigExists = await fs
        .stat(eslintConfigPath)
        .then(() => true)
        .catch(() => false);

      if (!eslintConfigExists) {
        const basicEslintConfig = {
          extends: "next/core-web-vitals",
        };
        await fs.writeFile(
          eslintConfigPath,
          JSON.stringify(basicEslintConfig, null, 2),
        );
      }

      lintOutput = await this.execCommand(
        `cd "${projectDir}" && ../../node_modules/.bin/next lint`,
        30000
      );
      lintSuccess = true;
      if (this.verbose) {
        console.log("✅ Lint completed");
      }
    } catch (error) {
      if (error && typeof error === "object" && "stdout" in error) {
        lintOutput = (error as any).stdout || "";
        if ((error as any).stderr) {
          lintOutput += "\n" + (error as any).stderr;
        }
      } else {
        lintOutput = error instanceof Error ? error.message : String(error);
      }
      if (this.verbose) {
        console.log("❌ Lint failed");
      }
    }

    // Run tests
    try {
      if (this.verbose) {
        console.log("Running tests...");
      }
      testOutput = await this.execCommand(
        `cd "${projectDir}" && ../../node_modules/.bin/vitest run`,
        30000
      );
      testSuccess = true;
      if (this.verbose) {
        console.log("✅ Tests completed");
      }
    } catch (error) {
      if (error && typeof error === "object" && "stdout" in error) {
        testOutput = (error as any).stdout || "";
        if ((error as any).stderr) {
          testOutput += "\n" + (error as any).stderr;
        }
      } else {
        testOutput = error instanceof Error ? error.message : String(error);
      }
      if (this.verbose) {
        console.log("❌ Tests failed");
      }
    }

    return {
      buildSuccess,
      buildOutput,
      lintSuccess,
      lintOutput,
      testSuccess,
      testOutput,
    };
  }

  private async execCommand(command: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      const process = exec(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout
      }, (error: any, stdout: string, stderr: string) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async cleanup(): Promise<void> {
    const promises = Array.from(this.processes.entries()).map(
      ([processId, process]) =>
        new Promise<void>((resolve) => {
          process.kill('SIGTERM');
          process.on('exit', () => {
            this.processes.delete(processId);
            resolve();
          });
          // Force kill after 5 seconds if not terminated
          setTimeout(() => {
            process.kill('SIGKILL');
            this.processes.delete(processId);
            resolve();
          }, 5000);
        })
    );
    await Promise.all(promises);
  }
}

export async function runCopilotEval(
  evalPath: string,
  options: CopilotEvalOptions = {}
): Promise<CopilotResult> {
  const evalsDir = path.join(process.cwd(), "evals");
  const fullEvalPath = path.join(evalsDir, evalPath);

  // Check if the eval directory exists
  const evalStat = await fs.stat(fullEvalPath).catch(() => null);
  if (!evalStat || !evalStat.isDirectory()) {
    throw new Error(`Eval directory not found: ${evalPath}`);
  }

  // Look for input directory
  const inputDir = path.join(fullEvalPath, "input");
  const inputExists = await fs
    .stat(inputDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!inputExists) {
    throw new Error(`No input directory found in ${evalPath}`);
  }

  // Read prompt from prompt.md
  const promptFile = path.join(fullEvalPath, "prompt.md");
  const promptExists = await fs
    .stat(promptFile)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!promptExists) {
    throw new Error(`No prompt.md file found in ${evalPath}`);
  }

  const prompt = await fs.readFile(promptFile, "utf8");
  const outputDir = path.join(fullEvalPath, "output-copilot");

  const runner = new CopilotRunner(options);

  try {
    const result = await runner.runCopilotEval(inputDir, outputDir, prompt, options.timeout);

    // Add evalPath and timestamp to result
    const enrichedResult: CopilotResult = {
      ...result,
      evalPath,
      timestamp: new Date().toISOString(),
    };

    // Write results to file if outputFile is specified
    if (options.outputFile) {
      try {
        await fs.writeFile(
          options.outputFile,
          JSON.stringify(enrichedResult, null, 2),
          "utf-8"
        );
        console.log(`\n📝 Results written to: ${options.outputFile}`);
      } catch (error) {
        console.error(
          `⚠️  Failed to write results to file: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return enrichedResult;
  } finally {
    await runner.cleanup();
  }
}
