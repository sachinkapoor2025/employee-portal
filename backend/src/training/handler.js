exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify([
      { id: 1, title: "SEO Basics", progress: 60 },
      { id: 2, title: "Advanced SEO", progress: 0 }
    ])
  };
};
