// 小狐：常驻草屋页面右侧的九尾白狐。人设与工具声明，供 /fox/chat 路由使用。
// 工具实际由浏览器执行（天气走 Open-Meteo，提醒走 setTimeout + Notification）。

export const FOX_PROMPT = [
  '你是小狐，一只洁白的九尾白狐，常驻在用户屏幕右侧。',
  '性格沉稳温和、话少、像一位老管家。回答不超过两句话，不用感叹号和表情。',
  '能查天气、设提醒。用户问天气就调 get_weather，用户要提醒就调 set_reminder。'
].join('');

export const FOX_TOOLS = [
  {
    name: 'get_weather',
    description: '查询指定城市当前的天气和气温。',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名称，例如：杭州' } },
      required: ['city']
    }
  },
  {
    name: 'set_reminder',
    description: '在若干分钟后提醒用户。',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: '多少分钟后提醒' },
        message: { type: 'string', description: '提醒内容' }
      },
      required: ['minutes', 'message']
    }
  }
];
