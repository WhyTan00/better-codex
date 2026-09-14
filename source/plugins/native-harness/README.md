# Native Harness adapter

This directory is a reference adapter for a single native execution owner. It exposes a small HTTP and event surface to the workbench shell while keeping provider authentication and transport behind the adapter boundary.

It is not a provider connector and does not include credentials. Wire it to a host that you control, keep thread ownership checks in the adapter, and do not start a second executor for the same conversation.
