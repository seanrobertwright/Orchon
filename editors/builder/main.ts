import { showPlaceholderStatus } from '../shared/placeholder.ts'

const status = document.getElementById('status')
if (status !== null) void showPlaceholderStatus(status)
