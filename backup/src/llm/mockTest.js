exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      questions: [
        {
          question: "What does SEO stand for?",
          options: ["Search Engine Optimization", "System Engine Output"],
          answer: 0
        }
      ]
    })
  };
};
