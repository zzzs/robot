export default () => ({
  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseUrl: process.env.DASHSCOPE_BASE_URL,
    model: process.env.DASHSCOPE_MODEL,
  },
});
