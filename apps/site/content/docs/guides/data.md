---
title: Data
description: Keep Databases, Documents and Canvases in an L4 Server, and let Agents and MCP clients read and update them.
order: 7
---

**Data** in the rail holds a Server's shared knowledge: Databases of records, Documents and Canvases. Everything stays inside one Server.

## Databases

A Database is a table of records. Create one with **New database**, then add fields with **+** in the header. Every record has a **Title**.

| Field | Holds |
| --- | --- |
| **Text**, **Number**, **Checkbox**, **Date** | A line of text, an amount, done or not, one day |
| **Select**, **Multi-select** | One option, or any number of options, from the field's list |
| **URL**, **Email**, **Phone** | An address you can open, write to or call from the record |
| **Person** | Members of this Server |
| **Relation** | Records of a Database, this one included; a link opens the record |

- Type in the last row to add a record, or use **Record**.
- Click a cell to edit it. **Open** on a row, or a card in any other view, opens the record as a page with every field.
- **Filter**, **Sort** and **Properties** above the table change the current view as you set them. Saved views keep their own filters, sort and shown fields; **View settings** has them all in one place.
- Views come as a **Table**, **Board** grouped by a Select field, **Calendar** on a Date field, **List** or **Gallery** of cards.
- **Search** filters the current view.
- Archive a Database you no longer use. **Archived databases** lists them for restoring.

## Documents

A Document is a page of formatted text. Create one with **New document**; it saves as you type. If you leave the page right after typing, the browser asks before discarding the last change.

## Canvases

A Canvas is a board of notes and text you can arrange and connect. Add items with **Note** or **Text**, drag them into place and link two of them with **Connect**.

## Who can do what

Three Role permissions cover Data:

| Permission | Allows |
| --- | --- |
| **Read data** | Read authorized tables, records and documents |
| **Write data** | Create and edit records and documents |
| **Manage data** | Create Databases, Documents, Canvases and fields |

## Agents and MCP

An Agent whose Role and the person who asks both allow it can find tables with `list_tables`, read records with `read_records`, add and change them with `create_record` and `update_record`, and read or write Documents. Multi-select, Person and Relation values are lists; `read_records` returns the titles of linked records alongside their ids. An Agent's Role can also be limited to chosen Databases and Documents.

MCP clients use the `data:read`, `data:write`, `data:manage`, `documents:read` and `documents:write` scopes. See [MCP](../agents/mcp.md).
