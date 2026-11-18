// PROTOTYPE: scenarios for `orca plugin check` and `orca plugin shot --scenario`.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  list: { persisted: { plugin: { 'proto.view': 'list', 'proto.scope': 'all' } } },
  list50: { persisted: { plugin: { 'proto.view': 'list', 'proto.scope': 'all', 'proto.scenario': 'fifty' } } },
  threadA: { persisted: { plugin: { 'proto.view': 'thread', 'proto.variant': 'A', 'proto.convId': 'conv-busy' } } },
  threadATools: {
    persisted: { plugin: { 'proto.view': 'thread', 'proto.variant': 'A', 'proto.convId': 'conv-busy', 'proto.scenario': 'tools' } },
  },
  threadB: { persisted: { plugin: { 'proto.view': 'thread', 'proto.variant': 'B', 'proto.convId': 'conv-busy' } } },
  threadLong: { persisted: { plugin: { 'proto.view': 'thread', 'proto.variant': 'A', 'proto.scenario': 'long' } } },
  threadEmpty: { persisted: { plugin: { 'proto.view': 'thread', 'proto.variant': 'A', 'proto.scenario': 'empty' } } },
  threadDelete: {
    persisted: {
      plugin: { 'proto.view': 'thread', 'proto.variant': 'A', 'proto.convId': 'conv-untitled', 'proto.scenario': 'delete' },
    },
  },
  threadCap500: {
    persisted: {
      plugin: { 'proto.view': 'thread', 'proto.variant': 'A', 'proto.convId': 'conv-busy', 'proto.scenario': 'cap500' },
    },
  },
})
