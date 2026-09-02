# v2.22.4

## Rollout chain owner controls

- Add owner-only **Start next stage monitoring** button in each rollout-chain panel.
- Add owner-only **Restart from Korea** button for both S26 and S25.
- Manual stage switches now enable the chain, activate only the selected stage, clear stale pending proposals, and force the selected targets due immediately.
- Add `/chainnext <s26|s25>` as an owner recovery command.
- `/chainstart <s26|s25>` now restarts either chain from Korea.
- A disabled but configured rollout chain is shown as **已暂停** instead of the misleading **待配置**.

The Samsung/Bifrost firmware-query implementation from v2.22.3 is unchanged.
