// Package schedule 是宿主级的「自动化任务」：按时间规则把一条指令投给某个对话
// （或每次新建一个对话）。
//
// 为什么放在宿主而不是交给 claude：claude 自己的 CronCreate / /loop 是
// session-scoped（SDK 原文：「cron tasks ... that will wake this session later」），
// 只能在原会话被唤醒，没有跨会话列表、暂停/恢复、运行记录，也不能新建对话。
// 本项目本身就是常驻宿主（会话进程、对话元数据、工作区围栏都在这里），所以调度、
// 存储、投递目标都由这一层负责；claude 只负责收到消息后干活。
//
// 分层：Rule 只算时间（纯函数），Store 只读写 schedules.json，Runner 只做
// 「到期 → 调 deliver 回调 → 记投递 → 算下一次」。真正的投递实现（起会话、
// 发 prompt、建对话）在 gateway，避免这一层依赖 agent 子域。
package schedule
