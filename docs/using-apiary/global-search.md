# Global search

The box at the top of every page (press **Ctrl+K** to jump to it) searches everything at once:

| Group | What is matched |
| --- | --- |
| Projects | Name and goal |
| Team | Names, titles and roles |
| Tasks | Title, notes and labels |
| Devices | Name, type, address and notes |
| Project templates | Name, description and goal |
| Past chats | The text of your messages and the agents' replies |
| Secret names | Names and notes only |

Every word you type must match, in any order. Press Enter to open the first result, or click any result. **Secret values are never searched or shown.** Secret names are only searched while the vault is unlocked; when it is locked, the results say so.

## API

`GET /api/search?q=...` returns `{ q, groups: [{ type, label, total, items: [{ title, sub, href }] }], note }`.
