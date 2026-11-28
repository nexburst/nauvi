# nauvi

A desktop app and CLI for watching and fixing Kubernetes clusters. This file
fixes the words the UI, the docs and the code use for its concepts.

## Language

**Overview**:
The first view of a context: what needs the user's attention now, at a glance.
_Avoid_: dashboard, home

**Problem pod**:
A pod the Overview lists because it is failing, not ready or stuck pending.
_Avoid_: broken pod, error pod

**Problem group**:
The Problem pods of one owning workload that share one reason, shown as one row.
_Avoid_: cluster (of errors), bucket

**Warning group**:
Warning events with the same reason on objects of one owner, shown as one row; events of a Problem group's pods belong to that group, not here.
_Avoid_: alert, event cluster

**Local terminal**:
A shell on the user's machine in the dock, at the app's context and namespace.
_Avoid_: console, shell (alone)

**Ask AI**:
Starting the user's own AI CLI in a Local terminal, pointed at a cluster, a namespace or one object.
_Avoid_: assistant, chat, agent

**AI context list**:
The objects the user collected to hand to the next Ask AI together.
_Avoid_: basket, cart, prompt builder

## Relationships

- A **Problem group** holds one or more **Problem pods** of the same workload and reason
- A **Problem pod** without an owning workload is shown alone, not in a **Problem group**
- The **Overview** shows at most 5 **Problem groups** and 5 **Warning groups**; the rest is one link away, never below the fold
- **Ask AI** runs in a **Local terminal**
- An **Ask AI** started with an **AI context list** names every object in it

## Example dialogue

> **Dev:** "The Deployment `web` has 18 pods in CrashLoopBackOff and 2 Pending. How many rows?"
> **Domain expert:** "Two **Problem groups**: `web` · CrashLoopBackOff · 18 pods, and `web` · Pending · 2 pods."
