import { useEffect, useState } from "react";

export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    //Here we have puth the relative path... Vite proxies this to Express. 
    fetch("/api/health")

      .then((res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        //from backend express we are receiving this response:
        // {
        //   status: "ok",
        //   service: "setu-server",
        //   time: new Date().toISOString(),
        // }

        //but in the response we get two things:

        //1. The Shipping Label (HTTP Protocol): This is the metadata about the delivery. It has an HTTP Status Code 
        //(like 200 for Success, 404 for Not Found, 500 for Server Error).

        //2. The Box Contents (JSON Data): This is the actual stuff inside the box ({ status: "ok", service: "setu-server" })

        //the res.ok here is referring to the http protocol, equals true if the HTTP status is anywhere between 200 and 299 
        //(which means success). It equals false if the status is 400 or 500+

        //if there is a problem we have set the backend code app.use((req,res)=>{res.status(404)})....hence res.ok will be false


        return res.json();
      })
      .then((data)=>{
        setHealth(data)
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Setu</h1>
      <p>Offline-First Field Data Collection Platform</p>

      <h2>Server connection</h2>
      {error && <p style={{ color: "crimson" }}>Failed: {error}</p>}
      {!error && !health && <p>Checking...</p>}
      {health && (
        <pre
          style={{
            background: "#f4f4f4",
            padding: "1rem",
            borderRadius: "6px",
          }}
        >
          {JSON.stringify(health, null, 2)}
        </pre>
      )}
    </div>
  );
}