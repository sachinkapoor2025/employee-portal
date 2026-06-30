exports.handler = async () => ({
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    questions: [
      {
        question: "What does SEO stand for?",
        options: ["Search Engine Optimization", "System Engine Output"],
        answer: 0,
      },
    ],
  }),
});
