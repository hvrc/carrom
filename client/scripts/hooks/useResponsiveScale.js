import { useEffect, useState } from "react";
import Draw from "../Draw";

// Responsive board scale: fit the 900px frame to the viewport (near-full width
// on mobile; bounded by width AND height with margin on desktop). Recomputes on
// resize.
export default function useResponsiveScale() {
    const [scale, setScale] = useState(1);

    useEffect(() => {
        const updateScale = () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            const isMobile = width <= 768;
            if (isMobile) {
                setScale((width - 20) / Draw.FRAME_SIZE);
            } else {
                const horizontalScale = (width - 100) / Draw.FRAME_SIZE;
                const verticalScale = (height - 100) / Draw.FRAME_SIZE;
                setScale(Math.min(horizontalScale, verticalScale) * 0.7);
            }
        };

        updateScale();
        window.addEventListener("resize", updateScale);
        return () => window.removeEventListener("resize", updateScale);
    }, []);

    return scale;
}
