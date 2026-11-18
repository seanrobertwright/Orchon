// PROTOTYPE: typed protocol between the chat-view panel and worker.

export interface ChatProtocol {
  requests: {
    'chat.ping': {
      input: undefined
      output: { ok: true; tick: number }
    }
    'chat.togglePoll': {
      input: { enabled: boolean }
      output: { enabled: boolean }
    }
  }
  posts: {
    'chat.tick': { tick: number; at: number }
  }
}

declare module 'orca' {
  interface PluginRequests {
    'chat.ping': ChatProtocol['requests']['chat.ping']
    'chat.togglePoll': ChatProtocol['requests']['chat.togglePoll']
  }
  interface PluginPosts {
    'chat.tick': ChatProtocol['posts']['chat.tick']
  }
}
