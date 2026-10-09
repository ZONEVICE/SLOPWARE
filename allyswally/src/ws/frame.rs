//! WebSocket frame reading and writing (RFC 6455 §5).
//!
//! Client-to-server frames are always masked; we unmask them. Server-to-client
//! frames are never masked. Fragmented data messages are reassembled; control
//! frames (ping/pong/close) are returned as they arrive. A payload-size ceiling
//! guards against a client asking us to allocate unbounded memory.

use std::io::{self, Read, Write};

/// Hard cap on a single reassembled message (16 MiB). The protocol here deals
/// in tiny JSON and input packets; anything larger is abuse or a bug.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// A decoded WebSocket message handed to the caller.
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

struct FrameHeader {
    fin: bool,
    opcode: u8,
    masked: bool,
    len: usize,
}

fn read_exact<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<()> {
    r.read_exact(buf)
}

fn read_header<R: Read>(r: &mut R) -> io::Result<Option<FrameHeader>> {
    let mut first2 = [0u8; 2];
    // A clean EOF before any byte means the peer closed the TCP connection.
    match r.read(&mut first2[..1]) {
        Ok(0) => return Ok(None),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    read_exact(r, &mut first2[1..2])?;

    let fin = first2[0] & 0x80 != 0;
    let opcode = first2[0] & 0x0F;
    let masked = first2[1] & 0x80 != 0;
    let len7 = (first2[1] & 0x7F) as usize;

    let len = match len7 {
        126 => {
            let mut b = [0u8; 2];
            read_exact(r, &mut b)?;
            u16::from_be_bytes(b) as usize
        }
        127 => {
            let mut b = [0u8; 8];
            read_exact(r, &mut b)?;
            u64::from_be_bytes(b) as usize
        }
        n => n,
    };

    if len > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "websocket frame exceeds maximum size",
        ));
    }
    Ok(Some(FrameHeader {
        fin,
        opcode,
        masked,
        len,
    }))
}

fn read_payload<R: Read>(r: &mut R, header: &FrameHeader) -> io::Result<Vec<u8>> {
    let mut mask = [0u8; 4];
    if header.masked {
        read_exact(r, &mut mask)?;
    }
    let mut payload = vec![0u8; header.len];
    read_exact(r, &mut payload)?;
    if header.masked {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }
    Ok(payload)
}

/// Read one complete message, reassembling fragments. Returns `Ok(None)` on a
/// clean connection close (EOF or a Close frame yields `Message::Close`).
pub fn read_message<R: Read>(r: &mut R) -> io::Result<Option<Message>> {
    let mut data: Vec<u8> = Vec::new();
    let mut data_opcode: u8 = 0;
    let mut assembling = false;

    loop {
        let header = match read_header(r)? {
            Some(h) => h,
            None => return Ok(None),
        };
        let payload = read_payload(r, &header)?;

        match header.opcode {
            OP_CLOSE => return Ok(Some(Message::Close)),
            OP_PING => return Ok(Some(Message::Ping(payload))),
            OP_PONG => return Ok(Some(Message::Pong(payload))),
            OP_TEXT | OP_BINARY => {
                if assembling {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "new data frame started before previous finished",
                    ));
                }
                if header.fin {
                    return finish(header.opcode, payload);
                }
                data_opcode = header.opcode;
                data = payload;
                assembling = true;
            }
            OP_CONTINUATION => {
                if !assembling {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "continuation frame with no start",
                    ));
                }
                data.extend_from_slice(&payload);
                if data.len() > MAX_MESSAGE {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "reassembled message exceeds maximum size",
                    ));
                }
                if header.fin {
                    return finish(data_opcode, std::mem::take(&mut data));
                }
            }
            other => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unknown websocket opcode {other}"),
                ));
            }
        }
    }
}

fn finish(opcode: u8, payload: Vec<u8>) -> io::Result<Option<Message>> {
    if opcode == OP_TEXT {
        match String::from_utf8(payload) {
            Ok(s) => Ok(Some(Message::Text(s))),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "text frame was not valid UTF-8",
            )),
        }
    } else {
        Ok(Some(Message::Binary(payload)))
    }
}

fn write_frame<W: Write>(w: &mut W, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = Vec::with_capacity(10);
    header.push(0x80 | opcode); // FIN set, single frame
    let len = payload.len();
    if len < 126 {
        header.push(len as u8);
    } else if len <= u16::MAX as usize {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    // Server frames are not masked.
    w.write_all(&header)?;
    w.write_all(payload)?;
    w.flush()
}

pub fn write_text<W: Write>(w: &mut W, text: &str) -> io::Result<()> {
    write_frame(w, OP_TEXT, text.as_bytes())
}

pub fn write_binary<W: Write>(w: &mut W, data: &[u8]) -> io::Result<()> {
    write_frame(w, OP_BINARY, data)
}

pub fn write_ping<W: Write>(w: &mut W, data: &[u8]) -> io::Result<()> {
    write_frame(w, OP_PING, data)
}

pub fn write_pong<W: Write>(w: &mut W, data: &[u8]) -> io::Result<()> {
    write_frame(w, OP_PONG, data)
}

pub fn write_close<W: Write>(w: &mut W) -> io::Result<()> {
    write_frame(w, OP_CLOSE, &[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Build a masked client text frame as a browser would send it.
    fn masked_text_frame(text: &str) -> Vec<u8> {
        let payload = text.as_bytes();
        let mask = [0x12, 0x34, 0x56, 0x78];
        let mut out = vec![0x80 | OP_TEXT, 0x80 | payload.len() as u8];
        out.extend_from_slice(&mask);
        for (i, &b) in payload.iter().enumerate() {
            out.push(b ^ mask[i % 4]);
        }
        out
    }

    #[test]
    fn reads_masked_text() {
        let frame = masked_text_frame("hello");
        let mut cur = Cursor::new(frame);
        assert_eq!(
            read_message(&mut cur).unwrap(),
            Some(Message::Text("hello".into()))
        );
    }

    #[test]
    fn reassembles_fragments() {
        // Two fragments "foo" + "bar": first text frame FIN=0, then continuation FIN=1.
        let mut frame = vec![OP_TEXT, 0x80 | 3];
        let mask = [1, 2, 3, 4];
        frame.extend_from_slice(&mask);
        for (i, &b) in b"foo".iter().enumerate() {
            frame.push(b ^ mask[i % 4]);
        }
        frame.push(0x80 | OP_CONTINUATION);
        frame.push(0x80 | 3);
        frame.extend_from_slice(&mask);
        for (i, &b) in b"bar".iter().enumerate() {
            frame.push(b ^ mask[i % 4]);
        }
        let mut cur = Cursor::new(frame);
        assert_eq!(
            read_message(&mut cur).unwrap(),
            Some(Message::Text("foobar".into()))
        );
    }

    #[test]
    fn clean_eof_returns_none() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        assert_eq!(read_message(&mut cur).unwrap(), None);
    }

    #[test]
    fn writes_unmasked_text_frame() {
        let mut out = Vec::new();
        write_text(&mut out, "hi").unwrap();
        assert_eq!(out, vec![0x81, 0x02, b'h', b'i']);
    }

    #[test]
    fn writes_extended_length() {
        let mut out = Vec::new();
        let payload = vec![b'x'; 200];
        write_binary(&mut out, &payload).unwrap();
        assert_eq!(out[0], 0x82);
        assert_eq!(out[1], 126);
        assert_eq!(u16::from_be_bytes([out[2], out[3]]), 200);
    }

    #[test]
    fn roundtrip_through_pipe() {
        // Write a server frame, then read it back as if we were the client:
        // server frames are unmasked, which read_message accepts.
        let mut buf = Vec::new();
        write_text(&mut buf, "roundtrip").unwrap();
        let mut cur = Cursor::new(buf);
        assert_eq!(
            read_message(&mut cur).unwrap(),
            Some(Message::Text("roundtrip".into()))
        );
    }
}
