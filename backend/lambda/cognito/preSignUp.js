exports.handler = async (event) => {
  const email = (event.request?.userAttributes?.email || "").toLowerCase();

  if (!email.endsWith("@mydgv.com")) {
    throw new Error("Only @mydgv.com email addresses can register.");
  }

  return event;
};
