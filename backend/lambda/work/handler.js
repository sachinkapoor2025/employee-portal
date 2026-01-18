exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify([
      {
        id: "TASK1",
        skill: "SEO",
        description: "Backlinking for containerbazar.com",
        hours: 100,
        status: "Open"
      }
    ])
  };
};
