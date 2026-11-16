import { TechnicianApp } from "../../components/TechnicianApp";

// A customer's environment: the same technician's screen, over that environment's machines.
// The screen reads the environment from its own address, and the server checks it on every
// request (an unknown or disabled environment answers nobody).
export default function EnvHome() {
  return <TechnicianApp />;
}
