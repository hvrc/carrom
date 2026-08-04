import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Menu from './Menu';
import Room from './Room';
import Playground from './Playground';
import Computer from './Computer';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Menu />} />
        {/* Before the catch-all below, or /playground reads as a room name. */}
        <Route path="/playground" element={<Playground />} />
        <Route path="/computer" element={<Computer />} />
        <Route path="/:roomName" element={<Room />} />
      </Routes>
    </BrowserRouter>
  );
}