import * as vscode from "vscode";
import { ApiClient } from "./api";
import { AuthService } from "./auth";
import { ProblemsetProvider } from "./views/problemsetProvider";
import { SubmissionProvider } from "./views/submissionProvider";
import { showProblemDetails, showSubmissionDetails } from "./webviews";

export function registerCommands(
  context: vscode.ExtensionContext,
  authService: AuthService,
  apiClient: ApiClient,
  problemsetProvider: ProblemsetProvider,
  submissionProvider: SubmissionProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("acmoj.setToken", async () => {
      const success = await authService.setToken();
      if (success) {
        problemsetProvider.refresh();
        submissionProvider.refresh();
      }
    }),

    vscode.commands.registerCommand("acmoj.clearToken", async () => {
      await authService.clearToken();
      problemsetProvider.refresh();
      submissionProvider.refresh();
    }),

    vscode.commands.registerCommand("acmoj.showMyProfile", () => {
      const profile = authService.getProfile();
      if (profile) {
        vscode.window.showInformationMessage(
          `Logged in as: ${profile.friendly_name} (${profile.username}), ID: ${profile.student_id || "N/A"
          }`,
          { modal: false }
        );
      } else {
        vscode.window.showWarningMessage("Not logged in to ACMOJ.");
      }
    }),

    vscode.commands.registerCommand("acmoj.viewProblemById", async () => {
      if (!authService.isLoggedIn()) {
        vscode.window
          .showWarningMessage(
            "Please set your ACMOJ Personal Access Token first.",
            "Set Token"
          )
          .then((selection) => {
            if (selection === "Set Token")
              vscode.commands.executeCommand("acmoj.setToken");
          });
        return;
      }

      const problemIdStr = await vscode.window.showInputBox({
        prompt: "Enter the Problem ID to view",
        validateInput: (text) =>
          /^\d+$/.test(text) ? null : "Please enter a valid number ID",
      });

      if (problemIdStr) {
        const problemId = parseInt(problemIdStr, 10);
        vscode.commands.executeCommand("acmoj.viewProblem", problemId);
      }
    }),

    vscode.commands.registerCommand("acmoj.refreshProblemsets", () => {
      if (!authService.isLoggedIn()) {
        vscode.window.showWarningMessage("Please login to ACMOJ first.");
        return;
      }
      problemsetProvider.refresh(); // Refresh the correct provider
    }),

    vscode.commands.registerCommand("acmoj.refreshSubmissions", () => {
      if (!authService.isLoggedIn()) {
        vscode.window.showWarningMessage("Please login to ACMOJ first.");
        return;
      }
      submissionProvider.refresh();
    }),

    vscode.commands.registerCommand(
      "acmoj.viewProblem",
      (problemId: number) => {
        if (!authService.isLoggedIn()) {
          vscode.window.showWarningMessage("Please login to ACMOJ first.");
          return;
        }
        if (typeof problemId === "number") {
          showProblemDetails(problemId, apiClient, context);
        } else {
          vscode.window.showErrorMessage("Invalid problem ID.");
        }
      }
    ),

    vscode.commands.registerCommand(
      "acmoj.viewSubmission",
      (submissionId: number) => {
        if (!authService.isLoggedIn()) {
          vscode.window.showWarningMessage("Please login to ACMOJ first.");
          return;
        }
        if (typeof submissionId === "number") {
          showSubmissionDetails(submissionId, apiClient, context);
        } else {
          vscode.window.showErrorMessage("Invalid submission ID.");
        }
      }
    ),

    vscode.commands.registerCommand(
      "acmoj.submitCurrentFile",
      async (contextArgs?: number | { problemId?: number }) => {
        if (!authService.isLoggedIn()) {
          vscode.window
            .showWarningMessage(
              "Please set your ACMOJ Personal Access Token first.",
              "Set Token"
            )
            .then((selection) => {
              if (selection === "Set Token")
                vscode.commands.executeCommand("acmoj.setToken");
            });
          return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage("No active editor found.");
          return;
        }

        const document = editor.document;
        const code = document.getText();
        const fileLanguageId = document.languageId;

        let problemId: number | undefined;

        if (typeof contextArgs === "number") {
          problemId = contextArgs;
        } else if (typeof contextArgs === "object" && contextArgs?.problemId) {
          // Handle message from Webview { command: 'submit', problemId: ... }
          problemId = contextArgs.problemId;
        }

        let attemptedProblemId: number | undefined;
        if (typeof problemId !== "number") {
          // read the first line. if it is "// acmoj: xxx", use xxx as the problem ID
          const firstLine = code.split("\n")[0].trim();
          const matchFirstLine = firstLine.match(/(?:\/\/|#)\s*acmoj:\s*(\d+)/);
          if (matchFirstLine) {
            attemptedProblemId = parseInt(matchFirstLine[1], 10);
          }
          else {
            // attempt to fetch the problem ID from the file name
            const fileName = document.fileName;
            const matchFileName = fileName.match(/\bP?(\d+)(?:\b|_)/);
            if (matchFileName) {
              attemptedProblemId = parseInt(matchFileName[1], 10);
            }
          }

          const problemIdStr = await vscode.window.showInputBox({
            prompt: "Enter the Problem ID to submit to",
            validateInput: (text) =>
              /^\d+$/.test(text) ? null : "Please enter a valid number ID",
            value: attemptedProblemId ? attemptedProblemId.toString() : "",
          });
          if (!problemIdStr) return;
          problemId = parseInt(problemIdStr, 10);
        }

        let availableLanguages: string[] = [
          "cpp",
          "python",
          "java",
          "c",
          "git",
          "verilog",
        ];
        try {
          const problem = await apiClient.getProblemDetails(problemId);
          if (problem.languages_accepted) {
            availableLanguages = problem.languages_accepted;
          }
        } catch (error) {
          console.warn(
            `Could not fetch accepted languages for problem ${problemId}:`,
            error
          );
        }

        const mappedLanguage = mapLanguageId(
          fileLanguageId,
          availableLanguages
        );

        const languageItems: vscode.QuickPickItem[] = availableLanguages.map(
          (lang) => ({ label: lang })
        );

        const selectedLanguageItem = await vscode.window.showQuickPick(
          languageItems,
          {
            placeHolder: "Select the language for submission",
          }
        );

        if (!selectedLanguageItem) return; // User cancelled

        const selectedLanguage = selectedLanguageItem.label;

        // write the problem ID to the first line of the file if it does not exist
        if (!attemptedProblemId || attemptedProblemId !== problemId) {
          const langCommentMap = {
            cpp: "//",
            python: "#",
            java: "//",
            c: "//",
            git: "#",
            verilog: "//",
          }
          if (selectedLanguage in langCommentMap) {
            const newFirstLine = `${langCommentMap[selectedLanguage as keyof typeof langCommentMap]} acmoj: ${problemId}\n`;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, 0, 0), newFirstLine);
            await vscode.workspace.applyEdit(edit);
          }
        }

        const confirm = await vscode.window.showQuickPick(["Yes", "No"], {
          placeHolder: `Submit code for Problem ${problemId} using ${selectedLanguage}?`,
        });
        if (confirm !== "Yes") return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `ACMOJ: Submitting P${problemId} (${selectedLanguage})...`,
            cancellable: false,
          },
          async (
            progress: vscode.Progress<{ message?: string; increment?: number }>
          ) => {
            try {
              const result = await apiClient.submitCode(
                problemId!,
                selectedLanguage,
                code
              );
              vscode.window.showInformationMessage(
                `Successfully submitted Problem ${problemId}. Submission ID: ${result.id}`
              );
              submissionProvider.refresh();
              // setTimeout(() => vscode.commands.executeCommand('acmoj.viewSubmission', result.id), 3000);
            } catch (error: any) {
              vscode.window.showErrorMessage(
                `Submission failed: ${error.message}`
              );
            }
          }
        );
      }
    ),

    vscode.commands.registerCommand(
      "acmoj.abortSubmission",
      async (submissionId: number) => {
        if (!authService.isLoggedIn()) {
          vscode.window.showWarningMessage("Please login to ACMOJ first.");
          return;
        }
        if (typeof submissionId !== "number") {
          vscode.window.showErrorMessage("Invalid submission ID.");
          return;
        }

        const confirm = await vscode.window.showQuickPick(["Yes", "No"], {
          placeHolder: `Abort submission #${submissionId}?`,
        });
        if (confirm !== "Yes") return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `ACMOJ: Aborting submission #${submissionId}...`,
            cancellable: false,
          },
          async (
            progress: vscode.Progress<{ message?: string; increment?: number }>
          ) => {
            try {
              await apiClient.abortSubmission(submissionId);
              vscode.window.showInformationMessage(
                `Submission #${submissionId} aborted.`
              );
              submissionProvider.refresh();
            } catch (error: any) {
              vscode.window.showErrorMessage(
                `Failed to abort submission: ${error.message}`
              );
            }
          }
        );
      }
    )
  );
}

function mapLanguageId(
  vscodeLangId: string,
  availableLangs: string[]
): string | undefined {
  const lowerId = vscodeLangId.toLowerCase();
  let potentialMatch: string | undefined;

  switch (lowerId) {
    case "cpp":
      potentialMatch = "cpp";
      break;
    case "python":
      potentialMatch = "python";
      break;
    case "java":
      potentialMatch = "java";
      break;
    case "c":
      potentialMatch = "c";
      break;
    case "git":
      potentialMatch = "plaintext"; // submit a git link as plain text
      break;
    case "verilog":
      potentialMatch = "verilog";
      break;
  }

  if (potentialMatch && availableLangs.includes(potentialMatch)) {
    return potentialMatch;
  }
  return undefined;
}
