import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import DurationHoursInput from "./DurationHoursInput";
import { HH_MM_HELPER, HH_MM_PLACEHOLDER } from "../utils/durationHours";

function Harness({ initial = "", onChange = jest.fn() }) {
  const [value, setValue] = useState(initial);
  return (
    <DurationHoursInput
      id="actual-hours"
      label="Total Actual Hours"
      required
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

test("shows HH:MM hint and labeled hour and minute fields", () => {
  render(<Harness />);
  expect(screen.getByRole("group", { name: "Total Actual Hours" })).toBeInTheDocument();
  expect(screen.getByLabelText("Total Actual Hours hours")).toBeInTheDocument();
  expect(screen.getByLabelText("Total Actual Hours minutes")).toBeInTheDocument();
  expect(screen.getByText(HH_MM_PLACEHOLDER)).toBeInTheDocument();
  expect(screen.getByText(HH_MM_HELPER)).toBeInTheDocument();
});

test("accepts typed durations longer than 23:59", () => {
  const onChange = jest.fn();
  render(<Harness initial="23:00" onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("Total Actual Hours hours"), {
    target: { value: "100" },
  });
  expect(onChange).toHaveBeenLastCalledWith("100:00");
  fireEvent.change(screen.getByLabelText("Total Actual Hours minutes"), {
    target: { value: "45" },
  });
  expect(onChange).toHaveBeenLastCalledWith("100:45");
});

test("allows typing 00:01 24:30 and 36:45", () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("Total Actual Hours hours"), {
    target: { value: "24" },
  });
  fireEvent.change(screen.getByLabelText("Total Actual Hours minutes"), {
    target: { value: "30" },
  });
  expect(onChange).toHaveBeenLastCalledWith("24:30");
  fireEvent.change(screen.getByLabelText("Total Actual Hours hours"), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText("Total Actual Hours minutes"), {
    target: { value: "1" },
  });
  fireEvent.blur(screen.getByLabelText("Total Actual Hours hours"));
  fireEvent.blur(screen.getByLabelText("Total Actual Hours minutes"));
  expect(onChange).toHaveBeenLastCalledWith("00:01");
});

test("keeps invalid minutes such as 60 so validation can reject them", () => {
  const onChange = jest.fn();
  render(<Harness initial="01:00" onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("Total Actual Hours minutes"), {
    target: { value: "60" },
  });
  expect(onChange).toHaveBeenLastCalledWith("01:60");
});

test("increment minutes from 23:59 rolls to 24:00", () => {
  const onChange = jest.fn();
  render(<Harness initial="23:59" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Increase Total Actual Hours minutes" }));
  expect(onChange).toHaveBeenLastCalledWith("24:00");
});

test("increment and decrement hours and minutes", () => {
  const onChange = jest.fn();
  render(<Harness initial="23:59" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Increase Total Actual Hours hours" }));
  expect(onChange).toHaveBeenLastCalledWith("24:59");
  fireEvent.click(screen.getByRole("button", { name: "Increase Total Actual Hours minutes" }));
  expect(onChange).toHaveBeenLastCalledWith("25:00");
  fireEvent.click(screen.getByRole("button", { name: "Decrease Total Actual Hours minutes" }));
  expect(onChange).toHaveBeenLastCalledWith("24:59");
  fireEvent.click(screen.getByRole("button", { name: "Decrease Total Actual Hours hours" }));
  expect(onChange).toHaveBeenLastCalledWith("23:59");
});
