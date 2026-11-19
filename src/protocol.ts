// The contract between the worker and the frames, declared once. The panel and the worker both
// read it through the type-check, so a name spelled differently on one side does not compile.
import type { ArtifactAnswer, ArtifactRequest, ArtifactsAnswer, ArtifactsRequest } from './artifacts-view'
import type { ChatRunAnswer, ChatRunRequest } from './chat-run-view'
import type { ChatsAnswer, ChatsRequest } from './chats-view'
import type { ThreadAnswer, ThreadRequest } from './chat-thread-view'
import type { ChatProjectsAnswer, ChatProjectsRequest, ChatSendAnswer, ChatSendRequest } from './chat-send-view'
import type { ConnectionAnswer, ConnectionView } from './connection-view'
import type { ConflictChoice, FormGroupId, FormsAnswer, FormsEdit, FormsView } from './forms-view'
import type { ConnectionReadAnswer, RunsHint, ShowRuns } from './hint-view'
import type { NotificationsTestAnswer, NotificationsView } from './notifications-view'
import type { RunAnswerRequest } from './run-answer-view'
import type { RunControlAnswer, RunControlRequest } from './run-control-view'
import type { RunDetailAnswer, RunDetailRequest } from './run-detail-view'
import type { RunsAnswer, RunsRequest } from './runs-view'
import type { LinkRequest, OpenRequest, RegisterRequest, ScopeAnswer } from './scope-view'
import type { SystemAnswer, SystemView } from './system-view'
import type { BuilderOpenAnswer, BuilderOpenRequest, GraphOpenAnswer, GraphOpenRequest } from './wide-tabs-view'
import type { LaunchAnswer, LaunchEdit, LaunchRequest, LaunchStart, NoticesAnswer, RerunRequest } from './launch-view'
import type { GraphAnswer, GraphRequest } from '../editors/run-graph/graph-view'
import type {
  BuilderAnswer,
  BuilderIdentity,
  BuilderRequest,
  BuilderSaveAnswer,
  BuilderSaveRequest,
  BuilderValidateAnswer,
  BuilderValidateRequest,
  YamlOpenAnswer
} from '../editors/builder/builder-view'
import type { DeleteAnswer, WorkflowDelete, WorkflowsAnswer, WorkflowsRequest } from './workflows-section-view'

declare module 'orca' {
  interface PluginRequests {
    /**
     * The connection state. Neither request takes an input. The read also carries the last press
     * of "Orchon: Show runs" while the worker remembers it, for a panel that mounts after it.
     */
    'connection.read': { output: ConnectionReadAnswer }
    /** "Try again": in Not found and Unsupported, runs discovery at once. */
    'connection.retry': { output: ConnectionAnswer }
    /** The runs table: the counts and rows 0 to N of one status filter, in one answer. */
    'runs.read': { input: RunsRequest; output: RunsAnswer }
    /** Run detail: one run's facts, its steps and what it waits for, in one answer. */
    'run.read': { input: RunDetailRequest; output: RunDetailAnswer }
    /** A run's artifacts: one folder's entries, or the paths a filter matches, at most 200. */
    'artifacts.read': { input: ArtifactsRequest; output: ArtifactsAnswer }
    /** One artifact the run's list holds: its facts and, when it is text within 256 KiB, its contents. */
    'artifact.read': { input: ArtifactRequest; output: ArtifactAnswer }
    /** Cancel, Abandon, Resume or Try now on one run: sent once, never tried again. */
    'run.control': { input: RunControlRequest; output: RunControlAnswer }
    /** Answers a gate through `respond` or an attention wait through `answer`, guarded by the question it was written for: sent once, never tried again. */
    'run.answer': { input: RunAnswerRequest; output: RunControlAnswer }
    /** The project scope of the focused workspace. It takes no input. */
    'scope.read': { output: ScopeAnswer }
    /** Links the focused Orca project to an Archon project Archon lists, or changes its link. */
    'scope.link': { input: LinkRequest; output: ScopeAnswer }
    /** Clears the focused Orca project's link. It takes no input. */
    'scope.unlink': { output: ScopeAnswer }
    /** Registers the main checkout folder the person confirmed with Archon, then reads the scope again. */
    'scope.register': { input: RegisterRequest; output: ScopeAnswer }
    /** Open in Orca: shows a workspace Orca lists, through `workspace.open`. */
    'workspace.open': { input: OpenRequest; output: null }
    /**
     * The Settings section began to show: reads health and the update check at once, then health
     * every 30 seconds until `system.close`. The System requests take no input.
     */
    'system.open': { output: SystemAnswer }
    /** Refresh: reads health and the update check at once. */
    'system.refresh': { output: SystemAnswer }
    /** The Settings section no longer shows: health is no longer read on the timer. */
    'system.close': { output: null }
    /**
     * Reads Archon's config and its providers. A group with unsaved edits keeps them and is not
     * refilled. It takes no input.
     */
    'forms.read': { output: FormsAnswer }
    /** New values for some fields of one group, kept in the worker's unsaved form. */
    'forms.edit': { input: FormsEdit; output: FormsAnswer }
    /** Returns one group to its loaded values. */
    'forms.discard': { input: { group: FormGroupId }; output: FormsAnswer }
    /**
     * Saves one group. The answer comes at once: with the group saving when the save started, and
     * then its outcome is posted as `forms.changed`; with the failed checks on their fields, and
     * nothing sent, when it did not.
     */
    'forms.save': { input: { group: FormGroupId }; output: FormsAnswer }
    /** Settles a save stopped by an outside change: load, overwrite or keep editing. */
    'forms.resolve': { input: { group: FormGroupId; choice: ConflictChoice }; output: FormsAnswer }
    /** The Notifications setting as the worker last read it. It takes no input. */
    'notifications.read': { output: NotificationsView }
    /** Send test notification: one notification naming no run, and whether Orca delivered it. It takes no input. */
    'notifications.test': { output: NotificationsTestAnswer }
    /** Open graph: writes the run's pointer file into `.orchon/` and opens it in a wide tab. */
    'graph.open': { input: GraphOpenRequest; output: GraphOpenAnswer }
    /** A run graph tab: the run on its workflow as it is now, and the connection as the tab draws it. */
    'graph.read': { input: GraphRequest; output: GraphAnswer }
    /** The Launch section: the form's lists, the draft and the Starting view. Reload reads Archon again. */
    'launch.read': { input: LaunchRequest; output: LaunchAnswer }
    /** Changes the focused workspace's draft. */
    'launch.edit': { input: LaunchEdit; output: LaunchAnswer }
    /** Start: creates a conversation and posts the run once, never again. A press while one posts is ignored. */
    'launch.start': { input: LaunchStart; output: LaunchAnswer }
    /**
     * Re-run: fills the focused workspace's draft from a completed or cancelled run, read from
     * Archon by the worker, and launches nothing.
     */
    'launch.rerun': { input: RerunRequest; output: LaunchAnswer }
    /** "Launch another": the form again in place of the Starting view. It takes no input. */
    'launch.another': { output: LaunchAnswer }
    /** "Keep waiting": the launch looks for its run for another 60 seconds. */
    'launch.wait': { input: { launchId: string }; output: LaunchAnswer }
    /** The callouts of runs launches started, and how many launches still look. It takes no input. */
    'launch.notices': { output: NoticesAnswer }
    /** Dismisses a callout, or a run the Starting view opened. */
    'launch.dismiss': { input: { launchId: string }; output: NoticesAnswer }
    /** The Launch section stopped showing, so a launch that fails now raises a notification. It takes no input. */
    'launch.hide': { output: null }
    /** "Edit and try again": the form again, filled in from the launch record. */
    'launch.retry': { input: { launchId: string }; output: LaunchAnswer }
    /** The Workflows section: the projects, the chosen project's workflows and where each comes from. */
    'workflows.read': { input: WorkflowsRequest; output: WorkflowsAnswer }
    /** Deletes one project or global workflow, once, then reads the list again. */
    'workflows.delete': { input: WorkflowDelete; output: DeleteAnswer }
    /** Open in builder: writes the workflow's pointer file into `.orchon/` and opens it in a wide tab. */
    'builder.open': { input: BuilderOpenRequest; output: BuilderOpenAnswer }
    /** A builder tab: the workflow's authored form, which file it is, and the connection as the tab draws it. */
    'builder.read': { input: BuilderRequest; output: BuilderAnswer }
    /** Open YAML: opens the workflow's file in Orca when it sits inside a local workspace Orca lists. */
    'builder.openYaml': { input: BuilderIdentity; output: YamlOpenAnswer }
    /**
     * Save: the outside-change check, Archon's validation, then one PUT, in that order. A save
     * that times out is not sent again; the worker reads the workflow to learn whether it landed.
     * One save at a time.
     */
    'builder.save': { input: BuilderSaveRequest; output: BuilderSaveAnswer }
    /** Validate: Archon's validation of a definition. Nothing is written. */
    'builder.validate': { input: BuilderValidateRequest; output: BuilderValidateAnswer }
    /** The chat list: the scope's web conversations with Archon's agent, without the launcher's own. */
    'chats.read': { input: ChatsRequest; output: ChatsAnswer }
    /** A chat thread: the conversation, its project and its newest saved messages, newest first. */
    'chat.read': { input: ThreadRequest; output: ThreadAnswer }
    /**
     * Send: posts one message to a conversation, or creates a new chat in a project Archon lists
     * with its first message. Sent once, never tried again; one send at a time.
     */
    'chat.send': { input: ChatSendRequest; output: ChatSendAnswer }
    /** A new chat's projects: Archon's list read afresh, and the scope's project when it names one. */
    'chat.projects': { input: ChatProjectsRequest; output: ChatProjectsAnswer }
    /** Open run on a dispatch row: the run that works in the worker conversation the dispatch named, once. */
    'chat.findRun': { input: ChatRunRequest; output: ChatRunAnswer }
  }
  interface PluginPanelEvents {
    /**
     * A hint that the person asked to see runs: when, and whether runs needed you then. It carries
     * no run data. Null is read as a press with no runs that need you.
     */
    'show-runs': ShowRuns | null
    /** A hint that the focused workspace changed, so the project scope may have. It carries no data. */
    'scope.changed': null
    /** The connection state, posted each time it changes. */
    'connection.changed': ConnectionView
    /** A hint that runs changed in Archon, at most one a second. It carries no run data. */
    'runs.changed': RunsHint
    /** A hint that the snapshot of runs that need you changed. It carries no data. */
    'needs-you.changed': null
    /** The System group, posted when a read that no request waits for has ended. */
    'system.changed': SystemView
    /** The Notifications setting, posted when it changes. */
    'notifications.changed': NotificationsView
    /** The editable groups, posted when a save or a read that no request waits for has ended. */
    'forms.changed': FormsView
    /** A hint that a launch changed: its run was found, or it waited 60 seconds. It carries no data. */
    'launch.changed': null
  }
}
