exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      chargedHours: 40,
      completedHours: 32,
      rating: "Good Performer"
    })
  };
};
