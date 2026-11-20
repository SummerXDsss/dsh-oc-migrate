# Project instructions

Always respond in Chinese-simplified.
尽可能高效，但是保留自然、友好的表达。

## Design Context

### Users
DeepSeek Harness 与 OpenCode 的个人用户，在自己的电脑迁移历史对话，希望保留上下文、看清真实进度，并且可以回滚。

### Brand Personality
清晰、平静、可信。中文文案简洁自然，不把技术实现当作用户操作说明。

### Aesthetic Direction
用户确认采用接近 OpenCode 的深色风格：炭黑背景、中性灰层次、米白文字和克制的暖色状态提示；默认深色，支持手动切换浅色。避免通用仪表盘卡片堆叠、渐变与装饰性图表。设计约定同时同步到 CLAUDE.md。

### Design Principles
1. 默认自动发现，一键迁移全部本地对话；项目、二进制、端口和令牌等选项收进高级设置，普通用户不需要配置。
2. 不展示假进度、示例任务和未经验证的成功状态。
3. 接收、目标、任务归属保持明确；回滚使用原任务目标并二次确认。
4. 路径可选择、错误可理解；令牌只展示文件路径。
5. 支持键盘、清晰焦点、暗色模式与减少动画偏好。
