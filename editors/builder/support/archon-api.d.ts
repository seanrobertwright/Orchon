// Archon's generated wire types for a workflow definition, the two schemas the copied builder
// logic reads (`types/wire.ts`). Taken from `components.schemas` of
// packages/web/src/lib/api.generated.d.ts at Archon v0.14.0, which openapi-typescript generates
// from the server's OpenAPI document. Only `WorkflowDefinition` and `DagNode` are kept; the text
// of each is unchanged. Type-only: it emits no JavaScript.
export interface components {
  schemas: {
    WorkflowDefinition: {
      name: string;
      description: string;
      provider?: string;
      model?: string | string[];
      /** @enum {string} */
      modelReasoningEffort?:
        | 'minimal'
        | 'low'
        | 'medium'
        | 'high'
        | 'xhigh'
        | 'max'
        | 'ultra'
        | 'persistent';
      /** @enum {string} */
      webSearchMode?: 'disabled' | 'cached' | 'live';
      /** @enum {string} */
      effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';
      fallbackModel?: string;
      betas?: string[];
      sandbox?: {
        enabled?: boolean;
        autoAllowBashIfSandboxed?: boolean;
        allowUnsandboxedCommands?: boolean;
        network?: {
          allowedDomains?: string[];
          allowManagedDomainsOnly?: boolean;
          allowUnixSockets?: string[];
          allowAllUnixSockets?: boolean;
          allowLocalBinding?: boolean;
          httpProxyPort?: number;
          socksProxyPort?: number;
        };
        filesystem?: {
          allowWrite?: string[];
          denyWrite?: string[];
          denyRead?: string[];
        };
        ignoreViolations?: {
          [key: string]: string[];
        };
        enableWeakerNestedSandbox?: boolean;
        enableWeakerNetworkIsolation?: boolean;
        excludedCommands?: string[];
        ripgrep?: {
          command: string;
          args?: string[];
        };
      } & {
        [key: string]: unknown;
      };
      worktree?: {
        enabled?: boolean;
      };
      container?: {
        enabled?: boolean;
        /** @enum {string} */
        write_back?: 'approve' | 'auto';
      };
      evidence_policy?: {
        required: boolean;
      };
      budget?: {
        max_work_units?: number;
        max_spend_usd?: number;
      };
      mutates_checkout?: boolean;
      persist_sessions?: boolean;
      tags?: string[];
      requires?: 'github'[];
      inputs?: {
        [key: string]: {
          required?: boolean;
          default?: unknown;
          description?: string;
        };
      };
      returns?: string;
      outcome_field?: string;
      deprecated?: {
        message: string;
      };
      nodes: components['schemas']['DagNode'][];
    };
    DagNode: {
      id: string;
      description?: string;
      depends_on?: string[];
      when?: string;
      /** @enum {string} */
      trigger_rule?: 'all_success' | 'one_success' | 'none_failed_min_one_success' | 'all_done';
      model?: string | string[];
      provider?: string;
      context?:
        | ('fresh' | 'shared')
        | {
            resume: string;
          };
      output_format?: {
        [key: string]: unknown;
      };
      allowed_tools?: string[];
      denied_tools?: string[];
      idle_timeout?: number;
      retry?: {
        max_attempts: number;
        delay_ms?: number;
        /** @enum {string} */
        on_error?: 'transient' | 'all';
      };
      hooks?: {
        PreToolUse?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        PostToolUse?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        PostToolUseFailure?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        Notification?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        UserPromptSubmit?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        SessionStart?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        SessionEnd?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        Stop?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        SubagentStart?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        SubagentStop?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        PreCompact?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        PermissionRequest?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        Setup?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        TeammateIdle?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        TaskCompleted?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        Elicitation?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        ElicitationResult?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        ConfigChange?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        WorktreeCreate?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        WorktreeRemove?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
        InstructionsLoaded?: {
          matcher?: string;
          response: {
            [key: string]: unknown;
          };
          timeout?: number;
        }[];
      };
      mcp?:
        | string
        | {
            path: string;
            optional?: boolean;
          };
      skills?: string[];
      plugins?: string[];
      agents?: {
        [key: string]: {
          description: string;
          prompt: string;
          model?: string;
          tools?: string[];
          disallowedTools?: string[];
          skills?: string[];
          maxTurns?: number;
        };
      };
      pi?: {
        enableExtensions?: boolean;
        interactive?: boolean;
        extensionFlags?: {
          [key: string]: boolean | string;
        };
      };
      /** @enum {string} */
      effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';
      maxBudgetUsd?: number;
      systemPrompt?: string;
      fallbackModel?: string;
      settingSources?: ('project' | 'user')[];
      betas?: string[];
      sandbox?: {
        enabled?: boolean;
        autoAllowBashIfSandboxed?: boolean;
        allowUnsandboxedCommands?: boolean;
        network?: {
          allowedDomains?: string[];
          allowManagedDomainsOnly?: boolean;
          allowUnixSockets?: string[];
          allowAllUnixSockets?: boolean;
          allowLocalBinding?: boolean;
          httpProxyPort?: number;
          socksProxyPort?: number;
        };
        filesystem?: {
          allowWrite?: string[];
          denyWrite?: string[];
          denyRead?: string[];
        };
        ignoreViolations?: {
          [key: string]: string[];
        };
        enableWeakerNestedSandbox?: boolean;
        enableWeakerNetworkIsolation?: boolean;
        excludedCommands?: string[];
        ripgrep?: {
          command: string;
          args?: string[];
        };
      } & {
        [key: string]: unknown;
      };
      always_run?: boolean;
      mutates_checkout?: boolean;
      persist_session?: boolean;
      output_type?: string;
      command?: string;
      with?: unknown;
      prompt?: string;
      bash?: string;
      timeout?: number;
      /** @enum {string} */
      on_timeout?: 'skip';
      loop?: {
        until?: string;
        max_iterations: number;
        /** @enum {string} */
        on_exhausted?: 'fail' | 'complete';
        /** @default false */
        fresh_context: boolean;
        until_bash?: string;
        interactive?: boolean;
        gate_message?: string;
        signal_completes?: boolean;
        prompt?: string;
        command?: string;
        until_field?: string;
      };
      loop_group?: {
        until?: string;
        max_iterations: number;
        /** @enum {string} */
        on_exhausted?: 'fail' | 'complete';
        /** @default false */
        fresh_context: boolean;
        until_bash?: string;
        interactive?: boolean;
        gate_message?: string;
        signal_completes?: boolean;
        nodes: components['schemas']['DagNode'][];
      };
      approval?: {
        message: string;
        decisions?: {
          id: string;
          label?: string;
        }[];
        capture_response?: boolean;
        on_reject?: {
          prompt: string;
          max_attempts?: number;
        };
      };
      wait?:
        | {
            duration_ms: number;
          }
        | {
            until: string;
          }
        | {
            event: string;
            deadline_ms: number;
          }
        | {
            attention: string;
            /** @enum {string} */
            form?: 'message' | 'approval' | 'select' | 'multi_select';
            options?:
              | {
                  id: string;
                  label?: string;
                  does?: string;
                  value?: unknown;
                }[]
              | string;
            recommendation?:
              | {
                  option: string;
                  why: string;
                  /** @enum {string} */
                  confidence?: 'low' | 'medium' | 'high';
                }
              | string;
            labels?: {
              [key: string]: string;
            };
          };
      cancel?: string;
      script?: string;
      /** @enum {string} */
      runtime?: 'bun' | 'uv';
      deps?: string[];
      include?: string;
      fan_out?: {
        items: string;
        as?: string;
        /** @default 5 */
        max_parallel: number | 'all';
        /**
         * @default all_done
         * @enum {string}
         */
        join: 'all_success' | 'all_done' | 'first_success';
      };
      workflow?: string;
      input?: string;
      /** @enum {string} */
      isolation?: 'inherit' | 'worktree';
    } & (
      | {
          /** @enum {string} */
          include?: never;
        }
      | {
          include: string;
          fan_out?: {
            items: string;
            as: string;
            /** @default 5 */
            max_parallel: number;
            /**
             * @default all_done
             * @enum {string}
             */
            join: 'all_success' | 'all_done' | 'first_success';
          };
        }
    );
  }
}
